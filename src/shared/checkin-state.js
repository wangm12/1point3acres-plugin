(function (global) {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const nodeSignature = (node) => {
    if (!node) return '';
    const attrs = ['name', 'id', 'value', 'data-value', 'data-qdxq', 'aria-label']
      .map((name) => `${name}=${clean(node.getAttribute?.(name))}`).join('|');
    return `${clean(node.textContent)}|${attrs}`;
  };
  const prepare = (node, href) => node && href ? { href, signature: nodeSignature(node), node } : null;
  const reconcile = (prepared, href, current) => {
    if (!prepared || prepared.href !== href || !current || nodeSignature(current) !== prepared.signature) return null;
    return { ...prepared, node: current };
  };
  const canConfirm = (prepared, href, current, submit) => Boolean(reconcile(prepared, href, current) && submit);
  global.CheckinState = Object.freeze({ nodeSignature, prepare, reconcile, canConfirm });
})(globalThis);
