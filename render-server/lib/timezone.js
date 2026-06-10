const IST_OFFSET_MINUTES = 330; // IST is UTC +05:30

/**
 * Gets the offset in minutes for an IANA timezone name at a given reference date.
 */
function getOffsetFromIANATimezone(timezoneName, date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezoneName,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false
  });

  const parts = formatter.formatToParts(date);
  const partMap = {};
  parts.forEach(p => partMap[p.type] = p.value);

  // Construct a Date representing that timezone's wall-clock time right now
  const targetLocal = new Date(Date.UTC(
    Number(partMap.year),
    Number(partMap.month) - 1,
    Number(partMap.day),
    Number(partMap.hour === '24' ? 0 : partMap.hour),
    Number(partMap.minute),
    Number(partMap.second || 0)
  ));

  // Difference in minutes between target timezone's wall clock and UTC wall clock
  const utcLocal = new Date(Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()
  ));

  return Math.round((targetLocal.getTime() - utcLocal.getTime()) / 60000);
}

/**
 * Dynamically queries Google Maps APIs to resolve any location string to its official IANA Timezone.
 */
async function fetchTimezoneFromGoogleMaps(locationStr) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.warn('Google Maps API key not found. Please set GOOGLE_MAPS_API_KEY in .env.local');
    return null;
  }

  try {
    // 1. Query Geocoding API to get Latitude & Longitude
    const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(locationStr)}&key=${apiKey}`;
    const geocodeRes = await fetch(geocodeUrl);
    const geocodeData = await geocodeRes.json();

    if (!geocodeData || geocodeData.status !== 'OK' || !geocodeData.results || geocodeData.results.length === 0) {
      console.warn(`Geocoding failed for location: "${locationStr}". Status: ${geocodeData ? geocodeData.status : 'Unknown'}`);
      return null;
    }

    const { lat, lng } = geocodeData.results[0].geometry.location;

    // 2. Query Time Zone API to get Timezone ID
    const timestamp = Math.floor(Date.now() / 1000);
    const tzUrl = `https://maps.googleapis.com/maps/api/timezone/json?location=${lat},${lng}&timestamp=${timestamp}&key=${apiKey}`;
    const tzRes = await fetch(tzUrl);
    const tzData = await tzRes.json();

    if (!tzData || tzData.status !== 'OK' || !tzData.timeZoneId) {
      console.warn(`Time Zone lookup failed for coordinates: ${lat}, ${lng}. Status: ${tzData ? tzData.status : 'Unknown'}`);
      return null;
    }

    return tzData.timeZoneId; // Returns standard IANA name e.g. "America/New_York"
  } catch (err) {
    console.error(`Google Maps API error for location "${locationStr}":`, err.message);
    return null;
  }
}

/**
 * Normalizes any location/timezone/offset value into standard offset minutes.
 * Now supports asynchronous dynamic Google Maps lookup.
 */
async function resolveTimezoneOffset(locationOrTz, referenceDate = new Date()) {
  if (!locationOrTz) return IST_OFFSET_MINUTES; // Fallback standard IST route

  const clean = String(locationOrTz).trim();
  if (!clean) return IST_OFFSET_MINUTES;

  // 1. Check if it's a valid IANA timezone name directly (e.g. "Asia/Kolkata")
  try {
    return getOffsetFromIANATimezone(clean, referenceDate);
  } catch (err) {
    // Not a direct IANA timezone name, continue
  }

  // 2. Check for standard UTC offsets like "+05:30", "-04:00", "+0900", "-05"
  const offsetMatch = clean.match(/^([+-])(\d{1,2}):?(\d{2})?$/);
  if (offsetMatch) {
    const sign = offsetMatch[1] === '-' ? -1 : 1;
    const hours = Number(offsetMatch[2]);
    const mins = Number(offsetMatch[3] || 0);
    return sign * (hours * 60 + mins);
  }

  // 3. Check for decimal numbers like "+5.5", "-4"
  const num = Number(clean);
  if (!isNaN(num)) {
    return Math.round(num * 60);
  }

  // 4. Dynamic lookup via Google Maps APIs
  const resolvedTzName = await fetchTimezoneFromGoogleMaps(clean);
  if (resolvedTzName) {
    try {
      return getOffsetFromIANATimezone(resolvedTzName, referenceDate);
    } catch (err) {
      // Failed to parse resolved timezone name
    }
  }

  // 5. Fallback standard
  return IST_OFFSET_MINUTES;
}

/**
 * Converts a day offset, clock time, and timezone or location to a UTC Date object.
 * Now asynchronous to support Google Maps API fetches!
 */
async function getUTCFromTimezone(dayOffset, timeStr, timezoneOrOffset, baseDate = null) {
  const reference = baseDate ? new Date(baseDate) : new Date();
  const actualNow = new Date();
  
  // 1. Resolve target timezone offset in minutes at the current time
  const offsetMinutes = await resolveTimezoneOffset(timezoneOrOffset, actualNow);
  
  // 2. Shift reference absolute UTC time to target timezone's local representation
  const targetNow = new Date(reference.getTime() + offsetMinutes * 60000);
  
  const daysToAdd = Number(dayOffset || 0);
  targetNow.setUTCDate(targetNow.getUTCDate() + daysToAdd);
  
  // 3. Apply the time mapping in the target timezone space
  if (timeStr) {
    const timeMatch = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (timeMatch) {
      const hh = Number(timeMatch[1]);
      const mm = Number(timeMatch[2]);
      targetNow.setUTCHours(hh, mm, 0, 0);
    }
  }
  
  // 4. Shift back to absolute UTC time
  const absoluteUTC = new Date(targetNow.getTime() - offsetMinutes * 60000);
  
  // 4.5. Enforce minimum delay if dayOffset specifies full days.
  if (daysToAdd > 0) {
    const minRequiredTime = new Date(reference.getTime() + (daysToAdd * 24 * 60 * 60 * 1000) - (5 * 60000));
    if (absoluteUTC < minRequiredTime) {
      // It shrinks the delay below the required 24hr chunks, so bump to next calendar day.
      absoluteUTC.setUTCDate(absoluteUTC.getUTCDate() + 1);
    }
  }
  
  // 5. Ensure the resulting time is strictly in the future
  if (absoluteUTC <= actualNow) {
    absoluteUTC.setTime(actualNow.getTime() + 60 * 1000);
  }
  
  return absoluteUTC;
}

/**
 * Backward compatibility wrapper for IST.
 */
async function getUTCFromIST(dayOffset, timeStr) {
  return await getUTCFromTimezone(dayOffset, timeStr, 'Asia/Kolkata');
}

module.exports = {
  getUTCFromTimezone,
  getUTCFromIST,
  resolveTimezoneOffset,
  fetchTimezoneFromGoogleMaps
};
