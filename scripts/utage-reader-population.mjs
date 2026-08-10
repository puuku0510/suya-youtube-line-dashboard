export function explicitCommonReaderId(value) {
  return value?.common_reader_id || value?.commonReaderId || value?.common_reader?.id || value?.reader?.common_reader_id || null;
}

export function buildAnalyticsPopulation(readers = [], friends = []) {
  const readersByCommon = new Map();
  for (const reader of readers) {
    const commonId = explicitCommonReaderId(reader);
    if (!commonId) continue;
    const group = readersByCommon.get(commonId) || [];
    group.push(reader);
    readersByCommon.set(commonId, group);
  }

  const friendsByCommon = new Map();
  for (const friend of friends) {
    const commonId = explicitCommonReaderId(friend);
    if (commonId) friendsByCommon.set(commonId, friend);
  }

  const commonIds = new Set([...readersByCommon.keys(), ...friendsByCommon.keys()]);
  return [...commonIds].map((commonId) => ({
    commonId,
    scenarioReaders: readersByCommon.get(commonId) || [],
    friend: friendsByCommon.get(commonId) || {}
  }));
}
