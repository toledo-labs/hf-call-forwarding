// File: voicemail-callback.js

exports.handler = function(context, event, callback) {
  // Get the recording URL and transcription
  const recordingUrl = event.RecordingUrl;
  const transcription = event.TranscriptionText || 'No transcription available.';
  const callerNumber = event.From || 'Unknown number';
  
  // Set up email client using Nodemailer with SMTP
  const nodemailer = require('nodemailer');
  
  // Create a transporter using SMTP credentials
  const transporter = nodemailer.createTransport({
    host: context.SMTP_HOST,
    port: context.SMTP_PORT,
    secure: context.SMTP_SECURE === 'true', // true for 465, false for other ports
    auth: {
      user: context.SMTP_USERNAME,
      pass: context.SMTP_PASSWORD
    }
  });
  
  // Setup email data
  const mailOptions = {
    from: context.SMTP_FROM_EMAIL,
    to: context.EMAIL_FOR_VOICEMAIL,
    subject: `New Voicemail from ${callerNumber}`,
    text: `You received a new voicemail from ${callerNumber}.\n\nTranscription: ${transcription}\n\nRecording: ${recordingUrl}`,
    html: `<p>You received a new voicemail from ${callerNumber}.</p>
           <h3>Transcription:</h3>
           <p>${transcription}</p>
           <h3>Recording:</h3>
           <p><a href="${recordingUrl}">Listen to recording</a></p>`
  };
  
  // Send the email
  transporter.sendMail(mailOptions)
    .then(info => {
      console.log('Email sent successfully');
      callback(null, 'Email sent');
    })
    .catch(error => {
      console.error('Error sending email:', error);
      callback(error);
    });
};