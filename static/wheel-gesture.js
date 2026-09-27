/** A wheel sequence may reach an edge or turn one page, never both. */
export class WheelGesture {
    constructor(gap = 250) {
        this.gap = gap;
        this.lastTime = -Infinity;
        this.direction = 0;
        this.consumed = false;
    }

    update(delta, now) {
        const direction = Math.sign(delta);
        const fresh = now - this.lastTime >= this.gap || direction !== this.direction;
        if (fresh) this.consumed = false;
        this.lastTime = now;
        this.direction = direction;
        return fresh;
    }

    consume() {
        this.consumed = true;
    }
}
