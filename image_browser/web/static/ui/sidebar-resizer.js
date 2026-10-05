/** Sidebar width is a session preference; CSS constrains it to the current viewport. */
export class SidebarResizer {
    constructor(pane, handle) {
        Object.assign(this, {pane, handle});
        const saved = Number(sessionStorage.getItem('sidebarWidth'));
        if (Number.isFinite(saved) && saved > 0) pane.style.setProperty('--tree-width', saved + 'px');
        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            event.preventDefault();
            this.drag = {x:event.clientX, width:pane.getBoundingClientRect().width};
            handle.setPointerCapture(event.pointerId);
        });
        handle.addEventListener('pointermove', event => {
            if (this.drag) this.setWidth(this.drag.width + event.clientX - this.drag.x);
        });
        handle.addEventListener('lostpointercapture', () => { this.drag = null; this.save(); });
        handle.addEventListener('keydown', event => {
            const {min, max, width} = this.geometry();
            const values = {ArrowLeft:width - 16, ArrowRight:width + 16, Home:min, End:max};
            if (!(event.key in values)) return;
            event.preventDefault(); event.stopPropagation();
            this.setWidth(values[event.key]); this.save();
        });
        new ResizeObserver(() => this.updateHandle()).observe(pane);
        window.addEventListener('resize', () => this.updateHandle());
        this.updateHandle();
    }

    geometry() {
        const style = getComputedStyle(this.pane);
        const number = name => parseFloat(style.getPropertyValue(name));
        const min = number('--tree-min-width');
        const max = Math.max(min, Math.min(number('--tree-max-width'),
            this.pane.parentElement.clientWidth - number('--workspace-min-width')));
        return {min, max, width:parseFloat(style.width)};
    }

    setWidth(width) {
        const geometry = this.geometry();
        const value = Math.round(Math.max(geometry.min, Math.min(geometry.max, width)));
        this.pane.style.setProperty('--tree-width', value + 'px');
        this.updateHandle({...geometry, width:value});
    }

    updateHandle({min, max, width} = this.geometry()) {
        this.handle.setAttribute('aria-valuemin', String(min));
        this.handle.setAttribute('aria-valuemax', String(max));
        this.handle.setAttribute('aria-valuenow', String(Math.round(width)));
        this.handle.setAttribute('aria-valuetext', Math.round(width) + ' pixels');
    }

    save() { sessionStorage.setItem('sidebarWidth', this.pane.style.getPropertyValue('--tree-width').replace('px', '')); }
}
