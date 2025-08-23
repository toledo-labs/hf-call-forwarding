// ------------------------------------------------------------
// call-forwarding.js built by Toledo1
// ------------------------------------------------------------

/**
 * Call Forwarding Function
 *
 * 1️⃣ Reads the current round‑robin index from a Sync document.
 * 2️⃣ Dials the next whitelisted number.  If the call is answered,
 *    Twilio will POST back to this function (action) with DialCallStatus.
 * 3️⃣ If all numbers are exhausted, the caller is sent to voicemail.
 * 4️⃣ The index is persisted for the next inbound call.
 *
 * All tunables are supplied via environment variables:
 *   - DIAL_TIMEOUT                (seconds, default 15)
 *   - CALLER_ID                   (verified Twilio number)
 *   - SYNC_SERVICE_SID            (Sync service SID)
 *   - PHONE_NUMBERS_ASSET         (path to JSON asset, default "/phone-numbers.json")
 *   - VOICEMAIL_TRANSCRIBE_CALLBACK (endpoint for transcript callbacks)
 *
 * The whitelist JSON must have the shape:
 * {
 *   "whitelistedNumbers": [
 *     { "name": "Alice", "number": "+15551234567" },
 *     { "name": "Bob",   "number": "+15557654321" }
 *   ]
 * }
 *
 * Numbers are validated against the E.164 format before use.
 */

exports.handler = async (context, event, callback) => {
  const forwarder = new CallForwarder({ context, event, callback });
  await forwarder.processCall(); // function handles its own callback
};

/* ------------------------------------------------------------------ */
/* --------------------------- CONFIG -------------------------------- */
/* ------------------------------------------------------------------ */
const VOICE_OPTS = { voice: 'Polly.Joanna', language: 'en-US' };
const PHONE_ASSET_PATH = '/phone-numbers.json';
const VOICEMAIL_CALLBACK = '/voicemail-callback';
const SPAM_THRESHOLD = 75; // Block calls with a TrueSpam score >= 75 (High Spam)

/* ------------------------------------------------------------------ */
/* --------------------------- CLASS --------------------------------- */
/* ------------------------------------------------------------------ */
class CallForwarder {
  constructor({ context, event, callback }) {
    this.context = context;
    this.event = event;
    this.callback = callback;

    // Twilio objects
    this.client = context.getTwilioClient();
    this.twiml = new Twilio.twiml.VoiceResponse();

    // Configurable options
    this.dialTimeout = Number(context.DIAL_TIMEOUT) || 15;
    this.syncServiceSid = context.SYNC_SERVICE_SID || 'default';
    this.syncDocumentName = 'callForwardingState';

    // Call state helpers
    this.isInitialCall = !event.DialCallStatus;
    this.isCallComplete = ['completed', 'answered'].includes(event.DialCallStatus);

    // Load and validate whitelist
    this.whitelistedNumbers = this.loadWhitelistedNumbers();
  }

  /* --------------------------------------------------------------
   * Load whitelist from a Runtime asset and filter out malformed
   * E.164 numbers.
   * ------------------------------------------------------------ */
  loadWhitelistedNumbers() {
    try {
      const assets = Runtime.getAssets();
      const asset = assets[PHONE_ASSET_PATH];
      if (!asset) throw new Error(`Asset ${PHONE_ASSET_PATH} not found`);

      const json = JSON.parse(asset.open());
      const filtered = (json.whitelistedNumbers || []).filter(
        ({ number }) => /^\+?[1-9]\d{1,14}$/.test(number)
      );

      return {
        numbers: filtered.map(entry => entry.number),
        names: filtered.map(entry => entry.name || '')
      };
    } catch (err) {
      console.error('Failed to load whitelist:', err);
      return { numbers: [], names: [] };
    }
  }

  /* --------------------------------------------------------------
   * Main entry point – orchestrates the whole flow.
   * ------------------------------------------------------------ */
  async processCall() {
    /* --------------------------------------------------------------
    * 0️⃣ TrueSpam spam‑check (enhanced safety & logging)
    * ------------------------------------------------------------ */
    const addOns = this.event.AddOns;

    // Verify that the Add‑on payload exists and is marked successful
    if (addOns && addOns.status === 'successful') {
      // Safe‑navigate to the TrueSpam result object
      const trueSpam = addOns.results?.truecnam_truespam;

      // Ensure the add‑on itself succeeded and that a result object is present
      if (trueSpam?.status === 'successful' && trueSpam.result) {
        // TrueSpam only scores numbers that exist in its database
        if (trueSpam.result.spam_score_match === 1) {
          // Coerce the score to a number (in case the API ever returns a string)
          const rawScore = trueSpam.result.spam_score;
          const score = Number(rawScore);

          // Log the decision – handy for monitoring / threshold tuning
          console.log(
            `TrueSpam check – From: ${this.event.From}, ` +
            `score: ${score}, threshold: ${SPAM_THRESHOLD}`
          );

          // Block the call if the score meets or exceeds our threshold
          if (score >= SPAM_THRESHOLD) {
            console.warn(
              `Blocking spam call from ${this.event.From}. TrueSpam score: ${score}`
            );
            this.twiml.reject({ reason: 'rejected' });
            return this.callback(null, this.twiml);
          }
        } else {
          // Number not in TrueSpam DB – just note it for diagnostics
          console.info(
            `TrueSpam: No match for ${this.event.From} (spam_score_match = 0)`
          );
        }
      } else {
        // Unexpected payload – we still want the call to proceed
        console.warn(
          'TrueSpam add‑on returned an unexpected payload or failed status:',
          trueSpam
        );
      }
    }
    // --------------------------------------------------------------
    // If we reach this point the call has either passed the spam check
    // or the add‑on was not available / not successful.
    // --------------------------------------------------------------

    try {
      // 1️⃣ Retrieve current index (and its etag for optimistic locking)
      const { index: currentIndex, etag } = await this.getCurrentIndexAndEtag();

      // 2️⃣ If the previous Dial already succeeded, just thank the caller
      if (this.isCallComplete) {
        this.twiml.say('Call connected successfully.', VOICE_OPTS);
        return this.callback(null, this.twiml);
      }

      // 3️⃣ Guard against missing whitelist
      if (!this.whitelistedNumbers.numbers.length) {
        this.twiml.say(
          "We're sorry, the call forwarding service is unavailable. Please try again later.",
          VOICE_OPTS
        );
        this.twiml.hangup();
        return this.callback(null, this.twiml);
      }

      // 4️⃣ If we've exhausted every number on a forwarded call → voicemail
      if (!this.isInitialCall && currentIndex >= this.whitelistedNumbers.numbers.length) {
        this.recordVoicemail();
        return this.callback(null, this.twiml);
      }

      // 5️⃣ Normal forwarding path – dial the next number in the round‑robin list
      const safeIdx = currentIndex % this.whitelistedNumbers.numbers.length;

      // 6️⃣ Persist the next index with optimistic lock
      const nextIdx = currentIndex + 1;
      this.updateCurrentIndex(nextIdx, etag);

      this.dialNumber(safeIdx);
      // Respond immediately – the caller receives the <Dial>
      this.callback(null, this.twiml);

    } catch (err) {
      console.error('Unexpected error in processCall:', err);
      this.twiml.say('An error occurred. Please try again later.', VOICE_OPTS);
      this.twiml.hangup();
      this.callback(null, this.twiml);
    }
  }
  
  /* --------------------------------------------------------------
   * Sync helpers – fetch document (create if missing) and return
   * both the stored index and the document's etag.
   * ------------------------------------------------------------ */
  async getCurrentIndexAndEtag() {
    const doc = await this.client.sync
      .v1.services(this.syncServiceSid)
      .documents(this.syncDocumentName)
      .fetch()
      .catch(async err => {
        if (err.status === 404) {
          // Document does not exist – create it with index 0
          const created = await this.client.sync
            .v1.services(this.syncServiceSid)
            .documents
            .create({ uniqueName: this.syncDocumentName, data: { currentIndex: 0 } });
          return created;
        }
        throw err;
      });

    return {
      index: doc.data?.currentIndex ?? 0,
      etag: doc.etag
    };
  }

  async updateCurrentIndex(newIndex, etag) {
    try {
      await this.client.sync
        .v1.services(this.syncServiceSid)
        .documents(this.syncDocumentName)
        .update({ data: { currentIndex: newIndex } }, { ifMatch: etag });
    } catch (e) {
      // 412 = Precondition Failed → another instance already updated the doc.
      if (e.status === 412) {
        console.warn('Sync index conflict – another function updated the value already.');
        return;
      }
      // Re‑throw any other unexpected error so the caller can log it.
      throw e;
    }
  }

  /* --------------------------------------------------------------
   * Build the <Dial> TwiML for the selected recipient.
   * ------------------------------------------------------------ */
  dialNumber(idx) {
    const name = this.whitelistedNumbers.names[idx] || `recipient ${idx + 1}`;
    this.twiml.say(
      `Please wait while we connect your call. Trying to reach ${name}.`,
      VOICE_OPTS
    );

    const dial = this.twiml.dial({
      timeout: this.dialTimeout,
      action: this.context.PATH, // Twilio will POST back here after <Dial>
      method: 'POST',
      callerId: this.context.CALLER_ID
    });

    dial.number(this.whitelistedNumbers.numbers[idx]);
  }

  /* --------------------------------------------------------------
   * Voicemail flow – plays prompts, records, and hangs up.
   * ------------------------------------------------------------ */
  recordVoicemail() {
    this.twiml.say(
      "We're sorry, but we couldn't reach anyone at this time.",
      VOICE_OPTS
    );
    this.twiml.say(
      'Please leave your name, message, and contact information after the beep.',
      VOICE_OPTS
    );
    this.twiml.record({
      transcribe: true,
      transcribeCallback: VOICEMAIL_CALLBACK,
      maxLength: 120,
      playBeep: true
    });
    this.twiml.say('Thank you. Goodbye.', VOICE_OPTS);
    this.twiml.hangup();
  }
}
