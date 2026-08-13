const { Queue } = require('bullmq');

const connection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
};

const emailQueue = new Queue('email-confirmation', { connection });

module.exports = { emailQueue, connection };