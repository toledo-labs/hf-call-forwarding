exports.handler = function(context, event, callback) {
  const callForwarder = new CallForwarder(context, event, callback);
  callForwarder.processCall();
};

class CallForwarder {
  constructor(context, event, callback) {
    // Context and event data
    this.context = context;
    this.event = event;
    this.callback = callback;
    this.client = context.getTwilioClient();
    this.twiml = new Twilio.twiml.VoiceResponse();
    
    // Configuration
    this.dialTimeout = 15;  // Seconds to wait before trying next number
    this.syncServiceSid = context.SYNC_SERVICE_SID || 'default';
    this.syncDocumentName = 'callForwardingState';
    
    // Call state
    this.isInitialCall = !event.DialCallStatus;
    this.isCallComplete = event.DialCallStatus === 'completed' || event.DialCallStatus === 'answered';
    
    // Load whitelisted numbers from JSON asset
    this.whitelistedNumbers = this.loadWhitelistedNumbers();
  }

  /**
   * Load whitelisted numbers from JSON asset
   * @returns {Object} Object containing numbers and names arrays
   */
  loadWhitelistedNumbers() {
    try {
      // Access the JSON asset
      const assets = Runtime.getAssets();
      const phoneNumbersAsset = assets['/phone-numbers.json'];
      
      if (!phoneNumbersAsset) {
        console.error('phone-numbers.json asset not found');
        // Return empty arrays instead of hardcoded fallback
        return {
          numbers: [],
          names: []
        };
      }
      
      // Parse the JSON content
      const phoneNumbersJson = JSON.parse(phoneNumbersAsset.open());
      
      // Extract numbers and names as separate arrays
      return {
        numbers: phoneNumbersJson.whitelistedNumbers.map(entry => entry.number),
        names: phoneNumbersJson.whitelistedNumbers.map(entry => entry.name)
      };
    } catch (err) {
      console.error('Error loading phone numbers:', err);
      // Return empty arrays instead of hardcoded fallback
      return {
        numbers: [],
        names: []
      };
    }
  }

  /**
   * Main method to process the incoming call
   */
  processCall() {
    this.getCurrentIndex()
      .then(currentIndex => {
        console.log(`Processing call with currentIndex: ${currentIndex}, isInitialCall: ${this.isInitialCall}, isCallComplete: ${this.isCallComplete}`);
        
        // If call is complete, end the program
        if (this.isCallComplete) {
          this.twiml.say('Call connected successfully.');
          return this.callback(null, this.twiml);
        }
        
        // Check if no phone numbers are available
        if (this.whitelistedNumbers.numbers.length === 0) {
          console.error('No phone numbers available for forwarding');
          this.twiml.say('We\'re sorry, but the call forwarding service is currently unavailable. Please try again later.');
          this.twiml.hangup();
          return this.callback(null, this.twiml);
        }
        
        // Check if we need to go to voicemail
        // Only check on forwarded calls, and only if we've tried all numbers
        if (!this.isInitialCall && currentIndex >= this.whitelistedNumbers.numbers.length) {
          this.recordVoicemail();
          return this.callback(null, this.twiml);
        }
        else if (this.isInitialCall && currentIndex >= this.whitelistedNumbers.numbers.length) {
          currentIndex = 0;
        }
        
        // Dial the current number
        this.dialNumber(currentIndex);
        
        // Always update the index for the next attempt
        const nextIndex = currentIndex + 1;
        this.updateCurrentIndex(nextIndex)
          .then(() => {
            this.callback(null, this.twiml);
          })
          .catch(err => {
            console.error('Error updating current index:', err);
            this.callback(err);
          });
      })
      .catch(err => {
        console.error('Error in processCall:', err);
        this.callback(err);
      });
  }

  /**
   * Retrieve the current index from the Sync service
   * @returns {Promise<number>} The current index
   */
  getCurrentIndex() {
    return this.getSyncDocument()
      .then(doc => doc.data.currentIndex);
  }

  /**
   * Get or create the Sync document containing our state
   * @returns {Promise<Object>} The Sync document
   */
  getSyncDocument() {
    return this.client.sync.v1.services(this.syncServiceSid)
      .documents(this.syncDocumentName)
      .fetch()
      .catch(err => {
        // If document doesn't exist, create it
        if (err.status === 404) {
          return this.client.sync.v1.services(this.syncServiceSid)
            .documents
            .create({
              uniqueName: this.syncDocumentName,
              data: { currentIndex: 0 }
            });
        }
        throw err;
      });
  }

  /**
   * Update the current index in the state document
   * @param {number} index The index to save
   * @returns {Promise<Object>} The updated document
   */
  updateCurrentIndex(index) {
    return this.client.sync.v1.services(this.syncServiceSid)
      .documents(this.syncDocumentName)
      .update({
        data: { currentIndex: index }
      });
  }

  /**
   * Dial a number from the whitelist
   * @param {number} index The index to dial
   */
  dialNumber(index) {
    // Ensure index is within bounds
    const safeIndex = index % this.whitelistedNumbers.numbers.length;
    
    // Get the name if available
    const recipientName = this.whitelistedNumbers.names[safeIndex] || `recipient ${safeIndex + 1}`;
    
    // Add a message before dialing (optional)
    this.twiml.say(
      `Please wait while we connect your call. Trying to reach ${recipientName}.`
    );
    
    // Dial the current number with a timeout
    const dial = this.twiml.dial({
      timeout: this.dialTimeout,
      action: this.context.PATH,
      method: 'POST',
      callerId: this.context.CALLER_ID // Using configured caller ID
    });

    dial.number(this.whitelistedNumbers.numbers[safeIndex]);
  }

  /**
   * Record a voicemail when no one answers
   */
  recordVoicemail() {
    this.twiml.say('No one is available to take your call. Please leave a message after the tone.');
    
    this.twiml.record({
      transcribe: true,
      transcribeCallback: '/voicemail-callback',
      maxLength: 120,
      playBeep: true
    });
    
    this.twiml.say('Thank you for your message. Goodbye.');
    this.twiml.hangup();
  }
}
