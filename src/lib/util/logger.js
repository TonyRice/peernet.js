import winston from 'winston'
const { combine, timestamp, label, printf } = winston.format

import BrowserConsole from 'winston-transport-browserconsole'

const formatter = combine(
  label({ label: 'peernet.js' }),
  timestamp(),
  printf(({ level, message, label, timestamp }) => {
    return `[${label}] ${timestamp} ${level}: ${message}`
  })
);

let transports = [];

if (typeof window !== 'undefined' && typeof jQuery !== 'undefined') {
  transports = transports.concat([
    new BrowserConsole({
      format: winston.format.simple(),
      level: 'debug'
    }),
  ])
} else {
  transports = transports.concat([
    new winston.transports.Console({
      format: formatter,
      level: 'debug'
    })
  ])
}

const logger = winston.createLogger({
  level: process.env.PEERNET_LOG_LEVEL ? process.env.PEERNET_LOG_LEVEL : 'info',
  format: formatter,
  transports: transports,
})

export default logger
