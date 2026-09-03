export function isTouchEvent(evt: Event): evt is TouchEvent {
    if (typeof TouchEvent !== 'undefined') return evt instanceof TouchEvent;
    return 'touches' in evt;
}
