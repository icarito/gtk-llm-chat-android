export class EventEmitter {
  constructor() {
    this._events = {};
    this._maxListeners = 10;
  }

  on(event, listener) {
    if (!this._events[event]) this._events[event] = [];
    this._events[event].push(listener);
    return this;
  }

  once(event, listener) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      listener.apply(this, args);
    };
    wrapper.listener = listener;
    this.on(event, wrapper);
    return this;
  }

  off(event, listener) {
    if (!this._events[event]) return this;
    const idx = this._events[event].indexOf(listener);
    if (idx >= 0) this._events[event].splice(idx, 1);
    return this;
  }

  emit(event, ...args) {
    const listeners = this._events[event];
    if (!listeners) return false;
    for (const fn of [...listeners]) fn.apply(this, args);
    return true;
  }

  removeAllListeners(event) {
    if (event) delete this._events[event];
    else this._events = {};
    return this;
  }

  removeListener(event, listener) {
    return this.off(event, listener);
  }

  addListener(event, listener) {
    return this.on(event, listener);
  }

  listenerCount(event) {
    return (this._events[event] || []).length;
  }

  listeners(event) {
    return [...(this._events[event] || [])];
  }
}
