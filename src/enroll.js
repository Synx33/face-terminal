// Shared by both enrollment paths (direct name+photo, and claim-a-pending-
// capture): creates the user on the device and, if a photo is given,
// uploads it as their face. A rejected photo (e.g. no clear face detected)
// doesn't undo the user creation — surfaced as a warning instead.

const db = require('./db');
const deviceClient = require('./deviceClient');

async function enrollEmployee({ name, jpegBuffer, dailyWage }) {
  const employeeNo = await deviceClient.nextEmployeeNo();
  await deviceClient.createDeviceUser({ employeeNo, name });
  db.upsertEmployee(employeeNo, name, dailyWage);

  let photoWarning;
  if (jpegBuffer) {
    try {
      await deviceClient.uploadFace({ employeeNo, jpegBuffer });
    } catch (err) {
      photoWarning = err.message;
    }
  }

  return { employeeNo, name, photoWarning };
}

module.exports = { enrollEmployee };
