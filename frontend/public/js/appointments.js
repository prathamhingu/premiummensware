(() => {
  const form = document.querySelector('[data-appointment-form]');
  if (!form) return;
  const dateInput = form.querySelector('[data-availability-date]');
  const timeSelect = form.querySelector('[data-availability-time]');
  const message = form.querySelector('[data-availability-message]');
  const originalMessage = message ? message.textContent.trim() : '';
  let requestNumber = 0;

  const showMessage = (text, state = '') => {
    if (!message) return;
    message.textContent = text;
    message.dataset.state = state;
  };
  const resetTime = (label = 'Choose a date first') => {
    timeSelect.replaceChildren(new Option(label, ''));
    timeSelect.disabled = true;
  };
  const loadSlots = async () => {
    const date = dateInput.value;
    const currentRequest = ++requestNumber;
    resetTime(date ? 'Checking availability…' : 'Choose a date first');
    if (!date) {
      showMessage(originalMessage || 'Choose a date to view available times.');
      return;
    }
    showMessage('Checking the store schedule…', 'loading');
    try {
      const response = await fetch(`${form.dataset.availabilityUrl}?date=${encodeURIComponent(date)}`, {
        headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store'
      });
      const data = await response.json();
      if (currentRequest !== requestNumber) return;
      if (!response.ok) throw new Error(data.reason || 'Availability could not be checked.');
      if (!Array.isArray(data.slots) || data.slots.length === 0) {
        resetTime('No available times');
        showMessage(data.reason || 'No appointment slots are available. Please choose another date or contact the store.', 'error');
        return;
      }
      timeSelect.replaceChildren(new Option('Choose an available time', ''));
      data.slots.forEach((slot) => timeSelect.add(new Option(slot.label, slot.time)));
      timeSelect.disabled = false;
      showMessage(`${data.slots.length} available start time${data.slots.length === 1 ? '' : 's'}. Select one to continue.`, 'success');
    } catch (error) {
      if (currentRequest !== requestNumber) return;
      resetTime('Availability unavailable');
      showMessage(error.message || 'Availability could not be checked. Refresh the page and try again.', 'error');
    }
  };

  dateInput.addEventListener('change', loadSlots);
  if (dateInput.value) loadSlots();
  form.addEventListener('submit', (event) => {
    if (timeSelect.disabled || !timeSelect.value) {
      event.preventDefault();
      showMessage('Choose an available time slot before submitting the request.', 'error');
      timeSelect.focus();
    }
  });
})();
