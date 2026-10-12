(() => {
  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      const message = form.getAttribute('data-confirm') || 'Are you sure?';
      if (!window.confirm(message)) event.preventDefault();
    });
  });


  const garmentRows = document.querySelector('[data-garment-rows]');
  const addGarmentButton = document.querySelector('[data-add-garment]');
  if (garmentRows && addGarmentButton) {
    const updateRemoveButtons = () => {
      const rows = Array.from(garmentRows.querySelectorAll('[data-garment-row]'));
      rows.forEach((row) => {
        const button = row.querySelector('[data-remove-garment]');
        if (button) button.hidden = rows.length <= 1;
      });
    };
    addGarmentButton.addEventListener('click', () => {
      if (garmentRows.querySelectorAll('[data-garment-row]').length >= 20) {
        window.alert('An order can contain up to 20 garment entries.');
        return;
      }
      const original = garmentRows.querySelector('[data-garment-row]');
      const clone = original.cloneNode(true);
      clone.querySelectorAll('input, textarea').forEach((field) => {
        if (field.name === 'quantity') field.value = '1';
        else field.value = '';
      });
      clone.querySelectorAll('select').forEach((field) => { field.selectedIndex = 0; });
      const remove = clone.querySelector('[data-remove-garment]');
      if (remove) remove.hidden = false;
      garmentRows.appendChild(clone);
      updateRemoveButtons();
      const first = clone.querySelector('select[name="garmentType"]');
      if (first) first.focus();
    });
    garmentRows.addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove-garment]');
      if (!button) return;
      const row = button.closest('[data-garment-row]');
      if (row && garmentRows.querySelectorAll('[data-garment-row]').length > 1) row.remove();
      updateRemoveButtons();
    });
    updateRemoveButtons();
  }

  const applyListFilters = (selector) => {
    const search = document.querySelector(`[data-list-filter="${selector}"]`);
    const status = document.querySelector(`[data-status-filter="${selector}"]`);
    const records = Array.from(document.querySelectorAll(`.${selector}`));
    const filter = () => {
      const query = search ? search.value.trim().toLowerCase() : '';
      const chosenStatus = status ? status.value : '';
      records.forEach((record) => {
        const matchesText = !query || (record.dataset.search || '').includes(query);
        const matchesStatus = !chosenStatus || record.dataset.status === chosenStatus;
        record.hidden = !(matchesText && matchesStatus);
      });
    };
    search?.addEventListener('input', filter);
    status?.addEventListener('change', filter);
  };
  applyListFilters('appointment-record');
  applyListFilters('order-record');

  const sideLinks = Array.from(document.querySelectorAll('.admin-side-link'));
  const sections = Array.from(document.querySelectorAll('.admin-section'));
  if ('IntersectionObserver' in window && sections.length && sideLinks.length) {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      sideLinks.forEach((link) => link.classList.toggle('is-current', link.getAttribute('href') === `#${visible.target.id}`));
    }, { rootMargin: '-15% 0px -70% 0px', threshold: [0, .1, .35] });
    sections.forEach((section) => observer.observe(section));
  }
})();
