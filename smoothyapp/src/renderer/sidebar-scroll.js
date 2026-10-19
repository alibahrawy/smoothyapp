// Decorative overflow hint only; wheel, trackpad and keyboard scrolling stay native.
export function initSidebarScroll() {
  const nav = document.getElementById('sidebar-nav');
  const viewport = nav.parentElement;
  let pending = false;
  const update = () => {
    pending = false;
    viewport.classList.toggle('has-more-tools', nav.scrollHeight - nav.clientHeight - nav.scrollTop > 2);
  };
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(update);
  };
  nav.addEventListener('scroll', schedule, { passive: true });
  const resize = new ResizeObserver(schedule);
  resize.observe(nav);
  for (const child of nav.children) resize.observe(child);
  new MutationObserver(schedule).observe(nav, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  document.fonts.ready.then(schedule);
  schedule();
}
