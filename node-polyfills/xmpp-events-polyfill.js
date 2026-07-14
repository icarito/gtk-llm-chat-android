import { EventEmitter } from '../events.js';
import timeout from './xmpp-timeout.js';
import delay from './xmpp-delay.js';
import Deferred from './xmpp-deferred.js';

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export {
  EventEmitter,
  timeout,
  delay,
  Deferred,
  tick,
};
