// Set up environment key mock so the geocoder attempts the API call
process.env.GOOGLE_MAPS_API_KEY = 'test-mock-key';

// Mock global.fetch to intercept and resolve Google Maps API geocoding & timezone calls
global.fetch = async (url) => {
  const urlStr = String(url).toLowerCase();
  
  if (urlStr.includes('maps.googleapis.com/maps/api/geocode/json')) {
    let lat = 0, lng = 0;
    if (urlStr.includes('london')) { lat = 51.5074; lng = -0.1278; }
    else if (urlStr.includes('new%20york') || urlStr.includes('ny') || urlStr.includes('nyc')) { lat = 40.7128; lng = -74.0060; }
    else if (urlStr.includes('tokyo')) { lat = 35.6762; lng = 139.6503; }
    
    return {
      ok: true,
      json: async () => ({
        status: 'OK',
        results: [{
          geometry: { location: { lat, lng } }
        }]
      })
    };
  }
  
  if (urlStr.includes('maps.googleapis.com/maps/api/timezone/json')) {
    let timeZoneId = 'UTC';
    if (urlStr.includes('51.5074,-0.1278') || urlStr.includes('london')) { timeZoneId = 'Europe/London'; }
    else if (urlStr.includes('40.7128,-74.006') || urlStr.includes('new%20york') || urlStr.includes('ny')) { timeZoneId = 'America/New_York'; }
    else if (urlStr.includes('35.6762,139.6503') || urlStr.includes('tokyo')) { timeZoneId = 'Asia/Tokyo'; }
    
    return {
      ok: true,
      json: async () => ({
        status: 'OK',
        timeZoneId
      })
    };
  }
  
  throw new Error(`Unexpected fetch URL in test: ${url}`);
};

const { resolveTimezoneOffset, getUTCFromTimezone } = require('../api/_lib/timezone');

function assert(condition, message) {
  if (!condition) {
    throw new Error('FAIL: ' + message);
  }
  console.log('  PASS:', message);
}

console.log('Running Timezone Resolution Tests...');

async function run() {
  try {
    // Test 1: Fallback standard (empty/invalid input -> IST 330 minutes)
    const defaultOffset = await resolveTimezoneOffset('');
    assert(defaultOffset === 330, 'Empty input should fallback to IST (330 mins). Actual: ' + defaultOffset);

    // Test 2: Standard Lookup Maps
    const londonOffset = await resolveTimezoneOffset('london');
    // London is either UTC+0 (GMT) or UTC+1 (BST). We test both depending on the date.
    assert(londonOffset === 0 || londonOffset === 60, 'London offset should be 0 (GMT) or 60 (BST). Actual: ' + londonOffset);

    const nyOffset = await resolveTimezoneOffset('new york');
    assert(nyOffset === -300 || nyOffset === -240, 'New York offset should be -300 (EST) or -240 (EDT). Actual: ' + nyOffset);

    const tokyoOffset = await resolveTimezoneOffset('tokyo');
    assert(tokyoOffset === 540, 'Tokyo offset should be 540 (JST). Actual: ' + tokyoOffset);

    // Test 3: IANA direct input
    const kolkataOffset = await resolveTimezoneOffset('Asia/Kolkata');
    assert(kolkataOffset === 330, 'Asia/Kolkata offset should be 330. Actual: ' + kolkataOffset);

    // Test 4: Offset input strings
    const offsetMins1 = await resolveTimezoneOffset('+05:30');
    assert(offsetMins1 === 330, '+05:30 string should map to 330. Actual: ' + offsetMins1);

    const offsetMins2 = await resolveTimezoneOffset('-04:00');
    assert(offsetMins2 === -240, '-04:00 string should map to -240. Actual: ' + offsetMins2);

    const offsetMins3 = await resolveTimezoneOffset('+0900');
    assert(offsetMins3 === 540, '+0900 string should map to 540. Actual: ' + offsetMins3);

    const offsetMins4 = await resolveTimezoneOffset('-5');
    assert(offsetMins4 === -300, '-5 decimal string should map to -300. Actual: ' + offsetMins4);

    // Test 5: Scheduling logic check
    // Schedule Tokyo at 10:00 AM on Day 1 (tomorrow)
    const tokyoScheduled = await getUTCFromTimezone(1, '10:00', 'Tokyo');
    
    // Format the resulting scheduled date back into Tokyo time to verify it actually represents 10:00 AM in Tokyo!
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      hour: 'numeric', minute: 'numeric', hour12: false
    });
    
    const tokyoLocalStr = formatter.format(tokyoScheduled);
    assert(tokyoLocalStr === '10:00', 'Calculated UTC for tomorrow should represent exactly 10:00 AM in Tokyo time. Actual: ' + tokyoLocalStr);

    console.log('\nSUCCESS: All timezone verification tests passed successfully!');
  } catch (error) {
    console.error('\nERROR: Test failed:', error.message);
    process.exit(1);
  }
}

run();
