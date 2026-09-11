// site/static/site.js – Kopier-Knöpfe der Webseite.
// data-copy zeigt auf das Element, dessen Text in die Zwischenablage soll.
document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const text = document.querySelector(button.dataset.copy)?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text.trim());
      const label = button.textContent;
      button.textContent = document.documentElement.lang === 'en' ? 'Copied ✓' : 'Kopiert ✓';
      setTimeout(() => (button.textContent = label), 1600);
    } catch {
      /* Zwischenablage gesperrt – der Text steht ja lesbar da. */
    }
  });
});
