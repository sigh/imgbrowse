import {sortSettings, SortCriterion, SortOrder} from '../shared/state.js';
import {byId, setButtonLabel} from '../shared/dom.js';

/** Shared controls; URL state and the server define their behavior. */
export class SortControls {
    constructor(popover, change) {
        this.popover = popover;
        this.trigger = byId('sort-toggle');
        this.direction = byId('sort-direction-toggle');
        this.criteria = [...popover.querySelectorAll('input[name="sort"]')];
        popover.addEventListener('change', event => {
            if (this.criteria.includes(event.target)) change({sort: event.target.value});
        });
        this.direction.addEventListener('click', () => change({order: this.nextOrder}));
        popover.addEventListener('beforetoggle', event => {
            if (event.newState === 'open') this.position();
        });
        popover.addEventListener('toggle', event => {
            this.trigger.setAttribute('aria-expanded', String(event.newState === 'open'));
        });
        window.addEventListener('resize', () => {
            if (popover.matches(':popover-open')) this.position();
        });
    }

    update(state) {
        const {sort, order} = sortSettings(state);
        const ascending = order === SortOrder.ASCENDING;
        this.nextOrder = ascending ? SortOrder.DESCENDING : SortOrder.ASCENDING;
        this.criteria.forEach(input => { input.checked = input.value === sort; });
        const label = this.criteria.find(input => input.checked).nextElementSibling.textContent;
        this.trigger.querySelector('.sort-caption').textContent = label;
        setButtonLabel(this.trigger, `Sort by ${label}`);
        const labels = sort === SortCriterion.MODIFIED
            ? ['Oldest first', 'Newest first'] : ['Name ascending', 'Name descending'];
        const index = ascending ? 0 : 1;
        this.direction.firstElementChild.textContent = index === 0 ? '↑' : '↓';
        const action = `Switch to ${labels[1 - index].toLowerCase()}`;
        setButtonLabel(this.direction, action, `${labels[index]}; ${action.toLowerCase()}`);
    }

    position() {
        const anchor = this.trigger.getBoundingClientRect();
        const top = document.querySelector('.app-header').getBoundingClientRect().bottom + 6;
        const width = parseFloat(getComputedStyle(this.popover).width);
        this.popover.style.left = `${Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8))}px`;
        this.popover.style.top = `${top}px`;
        this.popover.style.maxHeight = `${Math.max(0, innerHeight - top - 8)}px`;
    }
}
