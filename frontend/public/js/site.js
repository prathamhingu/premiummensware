(() => {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Accessible mobile navigation.
  const menuButton = document.querySelector('[data-menu-toggle]');
  const nav = document.querySelector('[data-nav]');
  if (menuButton && nav) {
    const closeMenu = () => {
      nav.classList.remove('is-open');
      menuButton.setAttribute('aria-expanded', 'false');
      menuButton.setAttribute('aria-label', 'Open navigation');
    };
    menuButton.addEventListener('click', () => {
      const open = nav.classList.toggle('is-open');
      menuButton.setAttribute('aria-expanded', String(open));
      menuButton.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    });
    nav.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu));
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });
    document.addEventListener('click', (event) => {
      if (!nav.contains(event.target) && !menuButton.contains(event.target)) closeMenu();
    });
  }

  // Lightweight collection search and category filtering. Links still work without JavaScript.
  const explorer = document.querySelector('[data-collection-explorer]');
  const collectionGrid = document.querySelector('[data-collection-grid]');
  if (explorer && collectionGrid) {
    const searchInput = explorer.querySelector('[data-collection-search]');
    const cards = Array.from(collectionGrid.querySelectorAll('[data-collection-card]'));
    const filters = Array.from(explorer.querySelectorAll('[data-category-filter]'));
    const emptyMessage = document.querySelector('[data-collection-no-results]');
    let activeCategory = filters.find((filter) => filter.classList.contains('is-active'))?.dataset.categoryFilter || 'all';
    const apply = () => {
      const query = (searchInput?.value || '').trim().toLocaleLowerCase();
      let visibleCount = 0;
      cards.forEach((card) => {
        const categoryMatches = activeCategory === 'all' || card.dataset.categoryId === activeCategory;
        const searchable = (card.dataset.searchText || card.textContent || '').toLocaleLowerCase();
        const searchMatches = !query || searchable.includes(query);
        const visible = categoryMatches && searchMatches;
        card.hidden = !visible;
        if (visible) visibleCount += 1;
      });
      if (emptyMessage) emptyMessage.hidden = visibleCount > 0;
      if (collectionGrid) collectionGrid.classList.toggle('has-filter-results', visibleCount > 0);
    };
    filters.forEach((filter) => filter.addEventListener('click', (event) => {
      // Keep native navigation available if the current page has no cards to filter.
      if (!cards.length) return;
      event.preventDefault();
      activeCategory = filter.dataset.categoryFilter || 'all';
      filters.forEach((entry) => {
        const selected = entry === filter;
        entry.classList.toggle('is-active', selected);
        entry.setAttribute('aria-current', selected ? 'true' : 'false');
      });
      const url = new URL(window.location.href);
      if (activeCategory === 'all') url.searchParams.delete('category');
      else url.searchParams.set('category', activeCategory);
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
      apply();
    }));
    searchInput?.addEventListener('input', apply);
    apply();
  }

  // Gallery category filters.
  const gallery = document.querySelector('[data-real-gallery]');
  if (gallery) {
    const cards = Array.from(gallery.querySelectorAll('[data-lightbox]'));
    const filters = Array.from(document.querySelectorAll('[data-gallery-filter]'));
    const emptyMessage = document.querySelector('[data-gallery-no-results]');
    filters.forEach((filter) => filter.addEventListener('click', () => {
      const category = filter.dataset.galleryFilter || 'all';
      let visible = 0;
      filters.forEach((item) => {
        const selected = item === filter;
        item.classList.toggle('is-active', selected);
        item.setAttribute('aria-pressed', String(selected));
      });
      cards.forEach((card) => {
        const show = category === 'all' || card.dataset.galleryCategory === category;
        card.hidden = !show;
        if (show) visible += 1;
      });
      if (emptyMessage) emptyMessage.hidden = visible > 0;
    }));
  }

  // Accessible gallery lightbox with keyboard navigation.
  const lightbox = document.querySelector('[data-lightbox-dialog]');
  if (lightbox) {
    const image = lightbox.querySelector('[data-lightbox-image]');
    const title = lightbox.querySelector('[data-lightbox-title]');
    const closeButtons = lightbox.querySelectorAll('[data-lightbox-close]');
    const previousButton = lightbox.querySelector('[data-lightbox-prev]');
    const nextButton = lightbox.querySelector('[data-lightbox-next]');
    let activeItems = [];
    let activeIndex = 0;
    let returnFocus = null;
    const getVisibleItems = () => Array.from(document.querySelectorAll('[data-lightbox]')).filter((item) => !item.hidden && item.offsetParent !== null);
    const showItem = (index) => {
      if (!activeItems.length) return;
      activeIndex = (index + activeItems.length) % activeItems.length;
      const item = activeItems[activeIndex];
      image.src = item.dataset.src || item.querySelector('img')?.src || '';
      image.alt = item.dataset.alt || item.querySelector('img')?.alt || '';
      title.textContent = item.dataset.title || '';
      const multi = activeItems.length > 1;
      if (previousButton) previousButton.hidden = !multi;
      if (nextButton) nextButton.hidden = !multi;
    };
    const close = () => {
      lightbox.classList.remove('is-open');
      lightbox.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('lightbox-open');
      image.src = '';
      if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus({ preventScroll: true });
    };
    document.querySelectorAll('[data-lightbox]').forEach((item) => item.addEventListener('click', () => {
      activeItems = getVisibleItems();
      activeIndex = Math.max(0, activeItems.indexOf(item));
      returnFocus = item;
      showItem(activeIndex);
      lightbox.classList.add('is-open');
      lightbox.setAttribute('aria-hidden', 'false');
      document.body.classList.add('lightbox-open');
      lightbox.querySelector('[data-lightbox-close]')?.focus({ preventScroll: true });
    }));
    closeButtons.forEach((button) => button.addEventListener('click', close));
    previousButton?.addEventListener('click', () => showItem(activeIndex - 1));
    nextButton?.addEventListener('click', () => showItem(activeIndex + 1));
    document.addEventListener('keydown', (event) => {
      if (!lightbox.classList.contains('is-open')) return;
      if (event.key === 'Escape') close();
      else if (event.key === 'ArrowLeft') showItem(activeIndex - 1);
      else if (event.key === 'ArrowRight') showItem(activeIndex + 1);
    });
  }

  // Suiting-style explorer. It gathers preferences only to help a customer speak to the store.
  const suitBrief = document.querySelector('[data-suiting-brief]');
  if (suitBrief) {
    const state = { occasion: 'Wedding & celebrations', style: 'Classic & timeless', fabric: '' };
    const summary = (key, value) => {
      const target = suitBrief.querySelector(`[data-brief-summary="${key}"]`);
      if (target) target.textContent = value || 'Not selected';
    };
    const updateWhatsApp = () => {
      const link = suitBrief.querySelector('[data-suiting-whatsapp]');
      const number = (suitBrief.dataset.whatsappNumber || '').replace(/\D/g, '');
      if (!link || !number) return;
      const businessName = suitBrief.dataset.businessName || 'the store';
      const lines = [
        `Hello ${businessName}, I would like to ask about suiting availability before visiting.`,
        `Occasion: ${state.occasion}`,
        `Preferred style direction: ${state.style}`,
        `Fabric interest: ${state.fabric || 'I would like to explore the available options'}`,
        'Please let me know the current options and opening hours. I understand availability should be confirmed by the store.'
      ];
      link.href = `https://wa.me/${number}?text=${encodeURIComponent(lines.join('\n'))}`;
    };
    const update = () => {
      Object.entries(state).forEach(([key, value]) => summary(key, value));
      updateWhatsApp();
    };
    suitBrief.querySelectorAll('[data-brief-choice]').forEach((button) => button.addEventListener('click', () => {
      const group = button.dataset.choiceGroup;
      const value = button.dataset.value || '';
      if (!['occasion', 'style'].includes(group)) return;
      state[group] = value;
      suitBrief.querySelectorAll(`[data-brief-choice][data-choice-group="${group}"]`).forEach((item) => {
        const selected = item === button;
        item.classList.toggle('is-selected', selected);
        item.setAttribute('aria-pressed', String(selected));
      });
      update();
    }));
    suitBrief.querySelectorAll('[data-fabric-pick]').forEach((button) => button.addEventListener('click', () => {
      const selected = button.classList.toggle('is-selected');
      suitBrief.querySelectorAll('[data-fabric-pick]').forEach((item) => {
        if (item !== button) item.classList.remove('is-selected');
        if (item !== button) item.textContent = 'Add to my enquiry ＋';
        item.setAttribute('aria-pressed', String(item === button && selected));
      });
      state.fabric = selected ? (button.dataset.value || '') : '';
      button.textContent = selected ? 'Selected for enquiry ✓' : 'Add to my enquiry ＋';
      update();
    }));
    update();
  }

  // Subtle reveal motion; content remains visible when JavaScript or IntersectionObserver is unavailable.
  if (!reduceMotion && 'IntersectionObserver' in window) {
    const revealTargets = Array.from(document.querySelectorAll('.section-heading, .intro-grid, .suiting-feature, .service-card, .tailoring-row, .showroom-choice-panel, .showroom-fabric-card, .store-visit-strip, .visit-cta'));
    if (revealTargets.length) {
      revealTargets.forEach((element) => element.setAttribute('data-reveal', ''));
      document.documentElement.classList.add('reveal-ready');
      const observer = new IntersectionObserver((entries, currentObserver) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-revealed');
          currentObserver.unobserve(entry.target);
        });
      }, { threshold: 0.08, rootMargin: '0px 0px -35px 0px' });
      revealTargets.forEach((element) => observer.observe(element));
    }
  }

  // Contact-form client validation complements server validation.
  const contactForm = document.querySelector('[data-contact-form]');
  if (contactForm) {
    contactForm.addEventListener('submit', (event) => {
      const name = contactForm.elements.namedItem('name');
      const phone = contactForm.elements.namedItem('phone');
      const message = contactForm.elements.namedItem('message');
      const email = contactForm.elements.namedItem('email');
      let invalid = false;
      [name, phone, message, email].forEach((field) => field && field.removeAttribute('aria-invalid'));
      if (!name.value.trim() || name.value.trim().length < 2) { name.setAttribute('aria-invalid', 'true'); invalid = true; }
      if (phone.value.replace(/\D/g, '').length < 7) { phone.setAttribute('aria-invalid', 'true'); invalid = true; }
      if (message.value.trim().length < 10) { message.setAttribute('aria-invalid', 'true'); invalid = true; }
      if (email.value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) { email.setAttribute('aria-invalid', 'true'); invalid = true; }
      if (invalid) {
        event.preventDefault();
        const firstInvalid = contactForm.querySelector('[aria-invalid="true"]');
        if (firstInvalid) { firstInvalid.focus(); firstInvalid.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' }); }
      }
    });
  }
})();
