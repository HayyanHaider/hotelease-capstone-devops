require('dotenv').config();
const mongoose = require('mongoose');
const express = require('express');
const client = require('prom-client');
const { Worker } = require('bullmq');
const { connection } = require('./queue');
const { sendEmail, emailTemplates } = require('./utils/emailService');
const BookingRepository = require('./repositories/BookingRepository');
const UserRepository = require('./repositories/UserRepository');

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const jobsProcessedCounter = new client.Counter({
  name: 'worker_jobs_processed_total',
  help: 'Total jobs processed by the worker',
  labelNames: ['status'],
});
register.registerMetric(jobsProcessedCounter);

async function startWorker() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
    });
    console.log('✅ [Worker] MongoDB connected');
  } catch (err) {
    console.error('❌ [Worker] MongoDB connection failed:', err.message);
    process.exit(1);
  }

  const worker = new Worker(
    'email-confirmation',
    async (job) => {
      if (job.name === 'cancellation-email') {
        const { bookingId, userId, refundAmount } = job.data;

        const booking = await BookingRepository.findById(bookingId, {
          populate: [
            { path: 'hotelId', select: 'name location address' },
            { path: 'couponId', select: 'code discountPercentage' }
          ]
        });

        const user = await UserRepository.findById(userId);

        if (user && booking && booking.hotelId) {
          const emailTemplate = emailTemplates.cancellationEmail(
            booking,
            booking.hotelId,
            { name: user.name, email: user.email },
            refundAmount
          );

          await sendEmail(
            user.email,
            emailTemplate.subject,
            emailTemplate.html,
            emailTemplate.text,
            { userId: userId, useUserGmail: true }
          );

          console.log(`✅ [Worker] Cancellation email sent to: ${user.email}`);
        } else {
          console.log(`⚠️ [Worker] Skipped job — missing user/booking/hotel data for booking ${bookingId}`);
        }
      }
    },
    { connection }
  );

  worker.on('completed', (job) => {
    jobsProcessedCounter.inc({ status: 'completed' });
    console.log(`Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    jobsProcessedCounter.inc({ status: 'failed' });
    console.error(`Job ${job.id} failed:`, err.message);
  });

  console.log('👷 Worker started, listening for jobs on "email-confirmation" queue...');

  const metricsApp = express();
  metricsApp.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  });
  const METRICS_PORT = process.env.METRICS_PORT || 9091;
  metricsApp.listen(METRICS_PORT, () => {
    console.log(`📊 Worker metrics available on port ${METRICS_PORT}`);
  });
}

startWorker();