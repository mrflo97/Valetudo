const DismissibleValetudoEvent = require("./DismissibleValetudoEvent");

class CommandQueueValetudoEvent extends DismissibleValetudoEvent {
    /**
     * Raised when a queued command could not be executed and was skipped
     *
     * @param {object}   options
     * @param {string}   options.message
     *
     * @param {string}  [options.id]
     * @param {Date}    [options.timestamp]
     * @param {boolean} [options.processed]
     * @param {object}  [options.metaData]
     * @class
     */
    constructor(options) {
        super(options);

        this.message = options.message;
    }
}

module.exports = CommandQueueValetudoEvent;
