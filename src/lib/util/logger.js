import winston from 'winston';
const { combine, timestamp, label, printf } = winston.format;

import BrowserConsole from "winston-transport-browserconsole";

const formatter = combine(
    label({ label: 'peernet.js' }),
    timestamp(),
    printf(({ level, message, label, timestamp }) => {
        return `[${label}] ${timestamp} ${level}: ${message}`;
    })
)
let transports = [];

if ((typeof window) !== 'undefined') {
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

if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: formatter,
    }));
}

export default logger;