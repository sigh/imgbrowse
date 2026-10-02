/** Converts wheel movement into native scrolling or page turns. */
export const WheelMode = Object.freeze({PAGE_TURN: 'page', NATIVE_SCROLL: 'scroll', EDGE_TURN: 'edge'});

export class WheelGesture {
    constructor() {
        this.lastTime = -Infinity;
        this.direction = 0;
        this.distance = 0;
        this.mode = WheelMode.PAGE_TURN;
    }

    update(delta, now, mode = WheelMode.PAGE_TURN) {
        const direction = Math.sign(delta);
        const fresh = now - this.lastTime >= 250 || direction !== this.direction;
        if (fresh) this.distance = 0;
        if (fresh || mode === WheelMode.PAGE_TURN) this.mode = mode;
        this.distance += Math.abs(delta);
        this.lastTime = now;
        this.direction = direction;
        const native = this.mode === WheelMode.NATIVE_SCROLL;
        const turn = !native && (fresh || (this.mode === WheelMode.PAGE_TURN && this.distance >= 100));
        if (turn) this.distance = 0;
        return {native, turn, fresh};
    }
}
