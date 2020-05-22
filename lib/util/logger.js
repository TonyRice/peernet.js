const winston = require('winston');
const { combine, timestamp, label, printf } = winston.format;

const BrowserConsole = require('winston-transport-browserconsole');

const formatter = combine(
    label({ label: 'peernet.js' }),
    timestamp(),
    printf(({ level, message, label, timestamp }) => {
        return `[${label}] ${timestamp} ${level}: ${message}`;
    })
)

const isBrowser = (typeof window) !== 'undefined';

let transports = [];

if (!isBrowser) {
    transports.concat([
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' })
    ])
} else {
    transports.concat([
        new BrowserConsole(
            {
                format: winston.format.simple(),
                level: 'info'
            }
        )
    ])
}

const logger = winston.createLogger({
    level: 'debug',
    format: formatter,
    transports: transports
});

if (process.env.NODE_ENV !== 'production' && !isBrowser) {
    logger.add(new winston.transports.Console({
        format: formatter,
    }));
}

module.exports = logger;