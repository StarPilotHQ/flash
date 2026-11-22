export function errorReport(attempt, reason, secrets = []) {
  return JSON.stringify({
    schema: 1,
    ...attempt,
    error: {
      name:reason?.name ?? 'Error',
      message:reason?.message ?? String(reason),
      cause:reason?.cause?.message,
      gpt:reason?.gpt,
    },
  }, (_, value) => {
    if (typeof value !== 'string') return value;
    value = value.replace(/https?:\/\/[^\s"'<>]+/gi, '[URL removed]');
    for (const secret of secrets.filter(Boolean)) {
      value = value.replaceAll(secret, '[redacted]');
    }
    return value.slice(0,500);
  }, 2) + '\n';
}
