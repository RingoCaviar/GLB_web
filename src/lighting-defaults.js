export async function loadDefaultLighting() {
  const response = await fetch('/__lighting-default/current', { cache: 'no-store' });
  const result = await response.json().catch(() => ({ error: 'INVALID_RESPONSE' }));
  if (!response.ok) throw new Error(result.error || 'READ_FAILED');
  return { lighting: result.lighting, writable: Boolean(result.writable) };
}

export async function saveDefaultLighting(lighting) {
  const response = await fetch('/__lighting-default/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lighting }),
  });
  const result = await response.json().catch(() => ({ error: 'INVALID_RESPONSE' }));
  if (!response.ok) throw new Error(result.error || 'WRITE_FAILED');
  return result.lighting;
}
