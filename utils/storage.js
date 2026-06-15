const store = chrome.storage.local;

export async function get(key) {
  const result = await store.get(key);
  return result[key] ?? null;
}

export async function set(key, value) {
  await store.set({ [key]: value });
}

export async function remove(key) {
  await store.remove(key);
}

export async function getAll(keys) {
  return store.get(keys);
}

export async function setAll(obj) {
  await store.set(obj);
}
