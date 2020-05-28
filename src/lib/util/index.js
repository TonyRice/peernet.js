import { uuid } from 'uuidv4';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function uuidv4() {
  return uuid();
}

export function randomData() {
  // TODO make this more random
  return uuidv4() + '-' + uuidv4()
}
