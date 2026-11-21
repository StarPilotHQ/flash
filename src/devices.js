export function imagesForDevice(release, deviceType) {
  switch (deviceType) {
    case '32':
      return release.c3Images;
    case '33':
    case '34':
      return release.images;
    default:
      throw new Error('This device does not support this AGNOS release');
  }
}
