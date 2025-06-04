# HF Call Forwarding

A Twilio-based call forwarding application that routes incoming calls to a sequence of phone numbers and captures voicemails when no one is available.

## Overview

This application provides an intelligent call forwarding solution using Twilio Functions. When a call comes in, the system will:

1. Try to reach a series of predefined phone numbers in sequence
2. If a person answers, connect the call
3. If no one answers after trying all numbers, record a voicemail
4. Email the voicemail recording and transcription to a specified email address

## Features

- **Sequential Call Forwarding**: Tries multiple numbers in order until someone answers
- **Configurable Timeouts**: Adjustable wait time before trying the next number
- **Personalized Greeting**: Announces the name of the person being called
- **Voicemail Recording**: Records messages when no one is available
- **Voicemail Transcription**: Automatically transcribes voicemail messages
- **Email Notifications**: Sends voicemail recordings and transcriptions via email
- **State Management**: Uses Twilio Sync to maintain state between function executions
- **Configurable Phone List**: Supports a JSON asset for easy management of forwarding numbers

## Setup Requirements

### Twilio Account Requirements

- Twilio Account with Functions and Assets enabled
- Twilio phone number for receiving incoming calls
- Twilio Sync Service

### Environment Variables

The following environment variables need to be configured in your Twilio Functions:

#### For Call Forwarding
- `SYNC_SERVICE_SID`: Your Twilio Sync Service SID
- `CALLER_ID`: Phone number to use as the caller ID for outgoing calls

#### For Voicemail Email Notifications
- `SMTP_HOST`: SMTP server hostname
- `SMTP_PORT`: SMTP server port
- `SMTP_SECURE`: Set to 'true' for SSL (port 465) or 'false' for other ports
- `SMTP_USERNAME`: SMTP username
- `SMTP_PASSWORD`: SMTP password
- `SMTP_FROM_EMAIL`: Sender email address
- `EMAIL_FOR_VOICEMAIL`: Recipient email address for voicemail notifications

### Dependencies

- Node.js v22 or higher
- Twilio Functions runtime
- Nodemailer (for email functionality)

## File Structure

- `call-fowarding.js`: Main call handling function that manages the forwarding logic
- `voicemail-callback.js`: Processes voicemail recordings and sends email notifications
- `phone-numbers.json`: Asset file containing the list of forwarding numbers and names

## Configuration

### Phone Numbers JSON Format

Create a JSON asset named `phone-numbers.json` with the following structure:

```json
{
  "whitelistedNumbers": [
    {
      "number": "+12345678901",
      "name": "Person1"
    },
    {
      "number": "+12345678902",
      "name": "Person2"
    },
    {
      "number": "+12345678903",
      "name": "Person3"
    }
  ]
}
```
**Important**:
- You must provide at least one valid phone number in the JSON asset. If no phone numbers are available, callers will receive an error message.
- Make sure to set the phone-numbers.json asset as **private** in your Twilio assets folder. This is required for the file to be properly read by the system and also protects sensitive phone number information.


## Deployment

1. Create a new Twilio Function Service
2. Upload the JavaScript files to the Functions directory
3. Upload the phone-numbers.json to the Assets directory
4. Configure the necessary environment variables
5. Set your Twilio phone number's voice webhook to point to the call-forwarding function
6. Deploy the service

## Usage

When someone calls your Twilio number:
1. The call will be forwarded to the first person in your list
2. If they don't answer within the timeout period, it will try the next person
3. This continues until someone answers or all numbers have been tried
4. If no one answers, the caller can leave a voicemail
5. The voicemail will be emailed to the configured address with transcription
6. If no phone numbers are configured or available, callers will hear an error message

## Customization

You can customize the application by:
- Adjusting the `dialTimeout` value in the code (default: 15 seconds)
- Modifying the greeting messages in the `dialNumber` and `recordVoicemail` methods
- Adding more phone numbers to the JSON asset
- Customizing the email template in voicemail-callback.js

## License

This project is available as open source under the terms of the [MIT License](LICENSE).
