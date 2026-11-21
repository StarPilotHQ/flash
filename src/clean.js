const CLEAN_LABELS = ['cache', 'userdata'];
const ERASE_SECTORS = 512n * 1024n;

export function planClean(partitions, firehose) {
  const preserved = partitions.filter(p => p.name === 'persist');
  if (preserved.length !== 1 || preserved[0].lun !== 0 || preserved[0].start !== 8n || preserved[0].sectors !== 8192n) {
    throw new Error('The protected persist partition could not be identified');
  }
  if (!firehose.cfg.FastErase) throw new Error('This device does not support recovery erase');
  return CLEAN_LABELS.map(name => {
    const matches = partitions.filter(p => p.name === name);
    if (matches.length !== 1 || matches[0].lun !== 0 || matches[0].start < 2n) {
      throw new Error(`Could not identify the ${name} partition safely`);
    }
    const part = matches[0];
    if (partitions.some(p => p !== part && p.lun === part.lun && p.start <= part.end && p.end >= part.start)) {
      throw new Error(`The ${name} partition overlaps other storage`);
    }
    return part;
  });
}

export async function eraseInstallData(device, partitions, status) {
  const {firehose} = device;
  for (const part of planClean(partitions, firehose)) {
    status(`Erasing ${part.name}`, 0, Number(part.sectors));
    for (let offset = 0n; offset < part.sectors; offset += ERASE_SECTORS) {
      const sectors = Number(part.sectors - offset < ERASE_SECTORS ? part.sectors - offset : ERASE_SECTORS);
      if (!await firehose.cmdErase(part.lun, part.start + offset, sectors)) {
        throw new Error(`The device rejected the erase of ${part.name}`);
      }
      status(`Erasing ${part.name}`, Number(offset) + sectors, Number(part.sectors));
    }
    const header = await firehose.cmdReadBuffer(part.lun, part.start, 1);
    if (header.length !== firehose.cfg.SECTOR_SIZE_IN_BYTES || header.some(byte => byte !== 0 && byte !== 255)) {
      throw new Error(`Could not verify the erase of ${part.name}`);
    }
  }
}
