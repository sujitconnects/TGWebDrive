export function normalizeDuplicateName(name = "") {
  return String(name || "")
    .trim()
    .replace(/[\\/]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function duplicateKey(item = {}) {
  const name = normalizeDuplicateName(item?.name ?? item?.caption ?? "");
  const size = Number(item?.size || 0);
  return `${name}::${size}`;
}

export function findDuplicateItems(items = []) {
  const grouped = new Map();

  for (const item of items || []) {
    const key = duplicateKey(item);
    if (!key || key.endsWith("::0")) {
      continue;
    }
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }

  return [...grouped.values()].filter((group) => group.length > 1);
}

export function hasDuplicateNameSize(candidate, existingItems = []) {
  if (!candidate || !candidate.name) return false;
  const candidateKey = duplicateKey(candidate);
  return (existingItems || []).some((item) => duplicateKey(item) === candidateKey);
}
