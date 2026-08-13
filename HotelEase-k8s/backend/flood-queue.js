require('dotenv').config();
const { emailQueue } = require('./queue');

async function flood() {
  const jobCount = 300;
  console.log(`Adding ${jobCount} fake jobs to the queue...`);

  for (let i = 0; i < jobCount; i++) {
    await emailQueue.add('cancellation-email', {
      bookingId: 'fake-booking-id',
      userId: 'fake-user-id',
      refundAmount: null,
    });
  }

  console.log('Done adding jobs.');
  process.exit(0);
}

flood();