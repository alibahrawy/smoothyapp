// DOM menus avoid OS-native select menus on both Mac and Windows.
export function createPhotoPicker(id, { searchable = false, menuWidth, onChange }) {
  const button = document.getElementById(id), popup = document.getElementById(`${id}-menu`);
  const list = popup.querySelector('[role="listbox"]'), search = popup.querySelector('input');
  const filters = [...popup.querySelectorAll('[data-model-filter]')];
  const triggerLogo = button.querySelector('.photo-model-logo');
  let triggerMonogram = button.querySelector('.photo-model-trigger-monogram');
  if (triggerLogo && !triggerMonogram) { triggerMonogram = document.createElement('span'); triggerMonogram.className = 'photo-model-trigger-monogram'; triggerMonogram.setAttribute('aria-hidden', 'true'); triggerLogo.after(triggerMonogram); }
  let items = [], activeFilter = 'all';
  const visible = () => [...list.querySelectorAll('[role="option"]')].filter(item => !item.hidden && !item.disabled);
  const selected = () => visible().find(item => item.dataset.value === button.value) || visible()[0];
  function filter() {
    const query = search?.value.trim().toLowerCase() || '';
    list.querySelectorAll('[role="option"]').forEach(option => {
      const item = items.find(item => item.value === option.dataset.value);
      option.hidden = !option.textContent.toLowerCase().includes(query) || (activeFilter !== 'all' && !item?.tags?.includes(activeFilter));
    });
    popup.querySelector('.photo-picker-empty')?.classList.toggle('hidden', visible().length > 0);
  }
  function choose(value, notify = true) {
    const item = items.find(item => item.value === value);
    if (!item) return;
    button.value = item.value;
    button.querySelector('.photo-picker-label').textContent = item.triggerLabel || item.label;
    if (triggerLogo) {
      if (item.logo) { triggerLogo.src = item.logo; triggerLogo.hidden = false; if (triggerMonogram) triggerMonogram.hidden = true; }
      else { triggerLogo.removeAttribute('src'); triggerLogo.hidden = true; if (triggerMonogram) { triggerMonogram.textContent = item.monogram || ''; triggerMonogram.hidden = !item.monogram; } }
    }
    list.querySelectorAll('[role="option"]').forEach(option => { const active = option.dataset.value === item.value; option.setAttribute('aria-selected', String(active)); option.tabIndex = active ? 0 : -1; });
    if (notify) onChange?.(value);
  }
  function setItems(next, preferred = button.value) {
    items = next; list.replaceChildren();
    items.forEach(item => {
      const option = document.createElement('button'); option.type = 'button'; option.setAttribute('role', 'option'); option.dataset.value = item.value;
      const text = document.createElement('span'), label = document.createElement('strong'); label.textContent = item.label; text.append(label);
      text.className = 'photo-picker-text';
      if (item.description) { const detail = document.createElement('small'); detail.textContent = item.description; text.append(detail); }
      if (item.price) { const price = document.createElement('small'); price.className = 'photo-picker-price'; price.textContent = item.price; text.append(price); }
      const check = document.createElement('span'); check.className = 'photo-picker-check'; check.textContent = '✓'; check.setAttribute('aria-hidden', 'true');
      if (item.logo || item.monogram) {
        const icon = document.createElement('span'); icon.className = 'photo-model-avatar'; icon.setAttribute('aria-hidden', 'true');
        if (item.logo) { const logo = document.createElement('img'); logo.src = item.logo; logo.alt = ''; logo.className = 'photo-model-logo'; icon.append(logo); }
        else icon.textContent = item.monogram;
        option.append(icon);
      }
      option.append(text, check); option.addEventListener('click', () => { if (button.disabled) return; choose(item.value); popup.hidePopover(); button.focus(); }); list.append(option);
    });
    choose(items.some(item => item.value === preferred) ? preferred : items[0]?.value, false); filter();
  }
  function setPrice(value, price) {
    const item = items.find(candidate => candidate.value === value), option = list.querySelector(`[data-value="${CSS.escape(value)}"]`), text = option?.querySelector('.photo-picker-text');
    if (!item || !text) return;
    item.price = price;
    let priceElement = text.querySelector('.photo-picker-price');
    if (!price) { priceElement?.remove(); return; }
    if (!priceElement) { priceElement = document.createElement('small'); priceElement.className = 'photo-picker-price'; text.append(priceElement); }
    priceElement.textContent = price;
  }
  function position() {
    const rect = button.getBoundingClientRect();
    const width = Math.min(menuWidth || (searchable ? 330 : 260), innerWidth - 24);
    const above = rect.top - 48, below = innerHeight - rect.bottom - 12;
    const useAbove = above >= below;
    popup.style.width = `${width}px`; popup.style.maxHeight = `${Math.max(100, Math.min(menuWidth ? 520 : 420, useAbove ? above : below))}px`;
    popup.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
    popup.style.top = useAbove ? 'auto' : `${rect.bottom + 6}px`;
    popup.style.bottom = useAbove ? `${innerHeight - rect.top + 6}px` : 'auto';
  }
  popup.addEventListener('beforetoggle', event => { if (event.newState === 'open') { if (search) search.value = ''; activeFilter = 'all'; filters.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.modelFilter === 'all'))); filter(); position(); } });
  popup.addEventListener('toggle', event => { const open = event.newState === 'open'; button.setAttribute('aria-expanded', String(open)); if (open) (search || selected())?.focus(); });
  button.addEventListener('keydown', event => { if (['ArrowDown', 'ArrowUp'].includes(event.key) && !button.disabled) { event.preventDefault(); popup.showPopover(); selected()?.focus(); } });
  popup.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); popup.hidePopover(); button.focus(); return; }
    const options = visible(), index = options.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % options.length : event.key === 'ArrowUp' ? (index < 0 ? options.length - 1 : (index + options.length - 1) % options.length) : event.key === 'Home' && document.activeElement !== search ? 0 : event.key === 'End' && document.activeElement !== search ? options.length - 1 : null;
    if (next !== null && options.length) { event.preventDefault(); options[next].focus(); }
  });
  search?.addEventListener('input', filter);
  filters.forEach(button => button.addEventListener('click', () => { activeFilter = button.dataset.modelFilter; filters.forEach(filterButton => filterButton.setAttribute('aria-pressed', String(filterButton === button))); filter(); }));
  window.addEventListener('resize', () => { if (popup.matches(':popover-open')) position(); });
  return { setItems, setPrice, select: value => choose(value), close: () => { if (popup.matches(':popover-open')) popup.hidePopover(); } };
}
