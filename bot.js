const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
require('dotenv').config();

// Configuration from environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const LTA_API_KEY = process.env.LTA_API_KEY;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Validate required environment variables
if (!BOT_TOKEN || !LTA_API_KEY) {
    console.error('❌ Missing required environment variables:');
    if (!BOT_TOKEN) console.error('   - BOT_TOKEN is required');
    if (!LTA_API_KEY) console.error('   - LTA_API_KEY is required');
    console.error('   Please check your .env file or Railway environment variables');
    process.exit(1);
}

// Debug API key (show first 8 characters only for security)
console.log('🔑 API Key (first 8 chars):', LTA_API_KEY.substring(0, 8) + '...');

// Initialize bot with bot commands
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Set bot commands for the command menu
bot.setMyCommands([
    { command: 'start', description: 'Start the bot and get welcome message' },
    { command: 'help', description: 'Show help and usage instructions' },
    { command: 'location', description: 'Share location to find nearby bus stops' },
    { command: 'search', description: 'Search by typing address or place name' },
    { command: 'debug', description: 'Show system status and debug info' },
    { command: 'test', description: 'Test API connection' },
    { command: 'settings', description: 'Adjust search radius and preferences' }
]);

// Updated API endpoints - trying multiple possible endpoints
const API_ENDPOINTS = {
    primary: 'https://datamall2.mytransport.sg/ltaodataservice',
    secondary: 'http://datamall2.mytransport.sg/ltaodataservice',
    // Alternative endpoints that might be working
    alternative1: 'https://api.datamall.lta.gov.sg/ltaodataservice',
    alternative2: 'http://api.datamall.lta.gov.sg/ltaodataservice'
};

// Updated configuration - increased search radius to 200m
const SEARCH_RADIUS = 200; // Increased from 50m to 200m
const MAX_BUS_STOPS = 5; // Increased to show more stops
const REQUEST_TIMEOUT = 20000; // Increased timeout for better reliability

// Store working API endpoint
let WORKING_API_ENDPOINT = null;

// In-memory storage
const userSessions = new Map();
const busStopsCache = {
    data: [],
    lastUpdated: 0
};

// User preferences storage
const userPreferences = new Map();

// Utility Functions
const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c;
};

const formatArrivalTime = (arrivalTime) => {
    if (!arrivalTime || arrivalTime === '') return 'No data';
    
    const now = new Date();
    const arrival = new Date(arrivalTime);
    
    // Check if the date is valid
    if (isNaN(arrival.getTime())) return 'No data';
    
    const diffMinutes = Math.round((arrival - now) / (1000 * 60));
    
    if (diffMinutes <= 0) return 'Arriving';
    if (diffMinutes === 1) return '1 min';
    if (diffMinutes > 60) return 'No data'; // Filter out unrealistic times
    return `${diffMinutes} mins`;
};

const formatLoad = (load) => {
    const loadMap = {
        'SEA': '🟢', // Seats Available
        'SDA': '🟡', // Standing Available
        'LSD': '🔴', // Limited Standing
    };
    return loadMap[load] || '⚪';
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Test API connectivity with correct endpoints
const testAPIConnection = async () => {
    console.log('🧪 Testing API connectivity...');
    
    for (const [name, baseUrl] of Object.entries(API_ENDPOINTS)) {
        console.log(`   Testing ${name}: ${baseUrl}`);
        
        // Test the correct endpoints as per official documentation
        const testEndpoints = [
            { endpoint: 'BusStops', description: 'Bus Stops' },
            { endpoint: 'v3/BusArrival', params: { BusStopCode: '01012' }, description: 'Bus Arrival v3' },
            { endpoint: 'BusServices', description: 'Bus Services' }
        ];
        
        for (const test of testEndpoints) {
            try {
                console.log(`   🔍 Testing endpoint: ${test.endpoint} (${test.description})`);
                
                const params = test.params || { '$skip': 0, '$top': 1 };
                
                const response = await axios.get(`${baseUrl}/${test.endpoint}`, {
                    headers: {
                        'AccountKey': LTA_API_KEY, // Correct header format per documentation
                        'accept': 'application/json'
                    },
                    params,
                    timeout: REQUEST_TIMEOUT
                });
                
                if (response.data && (response.data.value || response.data.Services || response.data.BusStopCode)) {
                    console.log(`   ✅ ${name} endpoint working with ${test.endpoint}!`);
                    console.log(`   📊 Response structure:`, Object.keys(response.data));
                    
                    // Test a specific bus stop to ensure arrivals work
                    if (test.endpoint === 'v3/BusArrival') {
                        console.log(`   📍 BusStopCode in response: ${response.data.BusStopCode}`);
                        console.log(`   🚌 Services found: ${response.data.Services?.length || 0}`);
                    }
                    
                    return baseUrl;
                }
                
            } catch (error) {
                console.log(`   ❌ ${test.endpoint} failed:`, error.response?.status, error.response?.statusText || error.message);
                if (error.response?.status === 404) {
                    console.log(`   💡 404 suggests endpoint doesn't exist or API structure changed`);
                }
            }
        }
    }
    
    console.log('❌ All API endpoints failed');
    return null;
};

// Enhanced API request function with correct authentication
const makeAPIRequest = async (endpoint, params = {}, retries = 3) => {
    if (!WORKING_API_ENDPOINT) {
        throw new Error('No working API endpoint available');
    }
    
    const url = `${WORKING_API_ENDPOINT}/${endpoint}`;
    console.log(`🌐 Making API request to: ${url}`);
    console.log(`📋 Parameters:`, params);
    
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
            console.log(`🔑 API request attempt ${attempt}`);
            
            const response = await axios.get(url, {
                headers: {
                    'AccountKey': LTA_API_KEY, // This is the correct header format per documentation
                    'accept': 'application/json',
                    'User-Agent': 'Singapore-Bus-Bot/3.0'
                },
                params,
                timeout: REQUEST_TIMEOUT
            });
            
            console.log(`✅ API request successful (attempt ${attempt})`);
            console.log(`📊 Response structure:`, Object.keys(response.data));
            
            return response.data;
            
        } catch (error) {
            console.error(`❌ API request attempt ${attempt} failed:`, {
                status: error.response?.status,
                statusText: error.response?.statusText,
                message: error.message,
                url: url
            });
            
            // Log detailed response for debugging
            if (error.response) {
                console.log(`📊 Error response details:`, {
                    status: error.response.status,
                    statusText: error.response.statusText,
                    headers: error.response.headers,
                    data: error.response.data
                });
            }
            
            if (attempt <= retries) {
                const delay = Math.pow(2, attempt) * 1000;
                console.log(`⏳ Retrying in ${delay}ms...`);
                await sleep(delay);
            } else {
                throw error;
            }
        }
    }
};

// Get all bus stops with correct endpoint
const getAllBusStops = async () => {
    console.log('🚌 Fetching bus stops data...');
    
    try {
        let allBusStops = [];
        let skip = 0;
        const limit = 500; // Per documentation, max 500 records per call
        let totalRequests = 0;

        while (true) {
            totalRequests++;
            console.log(`📡 Request ${totalRequests}: fetching ${limit} records (skip: ${skip})`);
            
            // Use correct endpoint as per documentation
            const data = await makeAPIRequest('BusStops', { 
                '$skip': skip,
                '$top': limit 
            });
            
            const busStops = data.value || data; // Handle different response formats
            if (!busStops || busStops.length === 0) {
                console.log('✅ No more bus stops to fetch');
                break;
            }

            allBusStops = allBusStops.concat(busStops);
            console.log(`📊 Progress: ${allBusStops.length} bus stops loaded`);
            
            skip += limit;

            // Add delay to respect rate limits
            if (busStops.length === limit) {
                await sleep(200);
            }
            
            // Safety check to avoid infinite loops
            if (totalRequests > 30) {
                console.log('⚠️ Safety limit reached, stopping fetch');
                break;
            }
        }

        if (allBusStops.length > 0) {
            busStopsCache.data = allBusStops;
            busStopsCache.lastUpdated = Date.now();
            
            console.log(`✅ Successfully loaded ${allBusStops.length} bus stops`);
            console.log(`📋 Sample bus stop:`, JSON.stringify(allBusStops[0], null, 2));
            return allBusStops;
        } else {
            throw new Error('No bus stops data received');
        }
        
    } catch (error) {
        console.error('❌ Error fetching bus stops:', error.message);
        console.error('Stack trace:', error.stack);
        return busStopsCache.data; // Return cached data if available
    }
};

const findNearbyBusStops = (userLat, userLng, busStops, radiusMeters = SEARCH_RADIUS) => {
    console.log(`🔍 Searching for bus stops within ${radiusMeters}m of (${userLat}, ${userLng})`);
    
    const nearby = [];
    
    for (const stop of busStops) {
        const distance = calculateDistance(userLat, userLng, stop.Latitude, stop.Longitude);
        if (distance <= radiusMeters) {
            nearby.push({
                ...stop,
                distance: Math.round(distance)
            });
        }
    }

    const sorted = nearby.sort((a, b) => a.distance - b.distance).slice(0, MAX_BUS_STOPS);
    console.log(`📍 Found ${sorted.length} nearby bus stops`);
    
    return sorted;
};

const getBusArrivals = async (busStopCode) => {
    console.log(`🚌 Getting arrivals for bus stop: ${busStopCode}`);
    
    try {
        // Use the correct v3 endpoint as per official documentation
        const data = await makeAPIRequest('v3/BusArrival', { 'BusStopCode': busStopCode });
        
        if (data && (data.Services || data.BusStopCode)) {
            console.log(`✅ Got arrival data for ${busStopCode}: ${data.Services?.length || 0} services`);
            return data;
        } else {
            console.log(`⚠️ No bus services found for ${busStopCode}`);
            return { Services: [], BusStopCode: busStopCode };
        }
    } catch (error) {
        console.error(`❌ Error fetching arrivals for ${busStopCode}:`, error.response?.status, error.message);
        
        // If 404, try the old endpoint as fallback
        if (error.response?.status === 404) {
            console.log(`🔄 Trying fallback endpoint for ${busStopCode}...`);
            try {
                const fallbackData = await makeAPIRequest('BusArrivalv2', { 'BusStopCode': busStopCode });
                console.log(`✅ Fallback successful for ${busStopCode}`);
                return fallbackData;
            } catch (fallbackError) {
                console.error(`❌ Fallback also failed for ${busStopCode}:`, fallbackError.message);
            }
        }
        
        return null;
    }
};

// Enhanced message formatting with better real-time data handling
const formatCombinedBusArrivalsMessage = async (nearbyStops) => {
    let combinedMessage = `🚌 *Bus Arrivals (${nearbyStops.length} stops within ${SEARCH_RADIUS}m)*\n\n`;
    
    for (const [index, busStop] of nearbyStops.entries()) {
        combinedMessage += `📍 *${busStop.Description}*\n`;
        combinedMessage += `🏷️ Stop: ${busStop.BusStopCode} • 📏 ${busStop.distance}m away\n`;
        
        try {
            const arrivalsData = await getBusArrivals(busStop.BusStopCode);
            
            if (!arrivalsData || !arrivalsData.Services || arrivalsData.Services.length === 0) {
                combinedMessage += `❌ No buses currently serving this stop\n`;
            } else {
                // Filter out services with no real arrival data
                const validServices = arrivalsData.Services.filter(service => {
                    return service.NextBus && 
                           service.NextBus.EstimatedArrival && 
                           service.NextBus.EstimatedArrival !== '' &&
                           service.NextBus.Monitored !== undefined;
                });
                
                if (validServices.length === 0) {
                    combinedMessage += `⏰ No real-time arrivals available\n`;
                } else {
                    const sortedServices = validServices.sort((a, b) => {
                        const numA = parseInt(a.ServiceNo) || 999;
                        const numB = parseInt(b.ServiceNo) || 999;
                        return numA - numB;
                    });

                    sortedServices.slice(0, 8).forEach(service => { // Limit to 8 buses per stop
                        const busNumber = service.ServiceNo;
                        const nextBus = formatArrivalTime(service.NextBus?.EstimatedArrival);
                        const nextBus2 = formatArrivalTime(service.NextBus2?.EstimatedArrival);
                        
                        const load1 = formatLoad(service.NextBus?.Load);
                        const load2 = formatLoad(service.NextBus2?.Load);
                        
                        // Show monitored status for debugging
                        const isRealTime = service.NextBus?.Monitored === 1 ? '📡' : '📅';

                        if (nextBus !== 'No data') {
                            combinedMessage += `🚍 ${busNumber}: ${load1} ${nextBus} ${isRealTime}`;
                            if (nextBus2 !== 'No data') {
                                combinedMessage += ` • ${load2} ${nextBus2}`;
                            }
                            combinedMessage += '\n';
                        }
                    });
                }
            }
        } catch (error) {
            console.error(`Error getting arrivals for ${busStop.BusStopCode}:`, error);
            combinedMessage += `❌ Error loading arrivals (API issue)\n`;
        }
        
        if (index < nearbyStops.length - 1) {
            combinedMessage += '\n';
        }
    }
    
    combinedMessage += '\n🟢 Seats Available • 🟡 Standing • 🔴 Limited Standing';
    combinedMessage += '\n📡 Real-time • 📅 Scheduled';
    combinedMessage += `\n\n🔄 Last updated: ${new Date().toLocaleTimeString()}`;
    
    return combinedMessage;
};

// Enhanced geocoding function with multiple providers
const geocodeAddress = async (address) => {
    console.log(`🔍 Geocoding address: "${address}"`);
    
    // Try OneMap first (Singapore's official service)
    try {
        console.log('   🇸🇬 Trying OneMap API...');
        const response = await axios.get('https://developers.onemap.sg/commonapi/search', {
            params: {
                searchVal: address,
                returnGeom: 'Y',
                getAddrDetails: 'Y',
                pageNum: 1
            },
            timeout: 10000
        });
        
        if (response.data && response.data.results && response.data.results.length > 0) {
            const result = response.data.results[0];
            console.log('   ✅ OneMap found result');
            return {
                latitude: parseFloat(result.LATITUDE),
                longitude: parseFloat(result.LONGITUDE),
                address: result.ADDRESS || result.SEARCHVAL,
                provider: 'OneMap'
            };
        }
    } catch (error) {
        console.log('   ❌ OneMap failed:', error.message);
    }
    
    // Try Nominatim (OpenStreetMap) as fallback
    try {
        console.log('   🌍 Trying Nominatim (OpenStreetMap)...');
        const response = await axios.get('https://nominatim.openstreetmap.org/search', {
            params: {
                q: `${address}, Singapore`,
                format: 'json',
                limit: 1,
                countrycodes: 'sg', // Restrict to Singapore
                addressdetails: 1
            },
            headers: {
                'User-Agent': 'Singapore-Bus-Bot/3.0'
            },
            timeout: 10000
        });
        
        if (response.data && response.data.length > 0) {
            const result = response.data[0];
            console.log('   ✅ Nominatim found result');
            return {
                latitude: parseFloat(result.lat),
                longitude: parseFloat(result.lon),
                address: result.display_name,
                provider: 'OpenStreetMap'
            };
        }
    } catch (error) {
        console.log('   ❌ Nominatim failed:', error.message);
    }
    
    // Try more specific Singapore search terms
    const singaporeSpecificTerms = [
        `${address} MRT station Singapore`,
        `${address} shopping mall Singapore`,
        `${address} Singapore`,
        `${address} station`,
        `${address} mall`
    ];
    
    for (const term of singaporeSpecificTerms) {
        try {
            console.log(`   🔍 Trying enhanced search: "${term}"`);
            const response = await axios.get('https://nominatim.openstreetmap.org/search', {
                params: {
                    q: term,
                    format: 'json',
                    limit: 1,
                    countrycodes: 'sg',
                    addressdetails: 1
                },
                headers: {
                    'User-Agent': 'Singapore-Bus-Bot/3.0'
                },
                timeout: 10000
            });
            
            if (response.data && response.data.length > 0) {
                const result = response.data[0];
                console.log(`   ✅ Enhanced search found result with term: "${term}"`);
                return {
                    latitude: parseFloat(result.lat),
                    longitude: parseFloat(result.lon),
                    address: result.display_name,
                    provider: 'OpenStreetMap Enhanced'
                };
            }
        } catch (error) {
            console.log(`   ❌ Enhanced search failed for "${term}":`, error.message);
        }
    }
    
    // Try fuzzy matching with common Singapore locations
    const commonLocations = {
        'yew tee': { lat: 1.3970, lng: 103.7470, name: 'Yew Tee MRT Station' },
        'yew tee station': { lat: 1.3970, lng: 103.7470, name: 'Yew Tee MRT Station' },
        'causeway point': { lat: 1.4361, lng: 103.7865, name: 'Causeway Point Shopping Mall' },
        'jurong point': { lat: 1.3398, lng: 103.7060, name: 'Jurong Point Shopping Centre' },
        'orchard road': { lat: 1.3048, lng: 103.8318, name: 'Orchard Road' },
        'marina bay sands': { lat: 1.2834, lng: 103.8607, name: 'Marina Bay Sands' },
        'changi airport': { lat: 1.3644, lng: 103.9915, name: 'Changi Airport' },
        'sentosa': { lat: 1.2494, lng: 103.8303, name: 'Sentosa Island' },
        'clarke quay': { lat: 1.2885, lng: 103.8467, name: 'Clarke Quay' },
        'raffles place': { lat: 1.2840, lng: 103.8510, name: 'Raffles Place MRT Station' },
        'city hall': { lat: 1.2932, lng: 103.8520, name: 'City Hall MRT Station' },
        'dhoby ghaut': { lat: 1.2985, lng: 103.8456, name: 'Dhoby Ghaut MRT Station' },
        'bugis': { lat: 1.3006, lng: 103.8560, name: 'Bugis MRT Station' },
        'little india': { lat: 1.3068, lng: 103.8492, name: 'Little India MRT Station' },
        'chinatown': { lat: 1.2836, lng: 103.8443, name: 'Chinatown MRT Station' },
        'harbourfront': { lat: 1.2653, lng: 103.8223, name: 'HarbourFront MRT Station' },
        'tanjong pagar': { lat: 1.2766, lng: 103.8459, name: 'Tanjong Pagar MRT Station' },
        'somerset': { lat: 1.3007, lng: 103.8390, name: 'Somerset MRT Station' },
        'newton': { lat: 1.3127, lng: 103.8388, name: 'Newton MRT Station' },
        'bishan': { lat: 1.3507, lng: 103.8480, name: 'Bishan MRT Station' },
        'ang mo kio': { lat: 1.3700, lng: 103.8495, name: 'Ang Mo Kio MRT Station' },
        'tampines': { lat: 1.3524, lng: 103.9448, name: 'Tampines MRT Station' },
        'bedok': { lat: 1.3240, lng: 103.9304, name: 'Bedok MRT Station' },
        'punggol': { lat: 1.4052, lng: 103.9021, name: 'Punggol MRT Station' },
        'sengkang': { lat: 1.3916, lng: 103.8953, name: 'Sengkang MRT Station' },
        'woodlands': { lat: 1.4370, lng: 103.7862, name: 'Woodlands MRT Station' },
        'jurong east': { lat: 1.3330, lng: 103.7436, name: 'Jurong East MRT Station' },
        'boon lay': { lat: 1.3387, lng: 103.7065, name: 'Boon Lay MRT Station' },
        'tuas link': { lat: 1.3404, lng: 103.6366, name: 'Tuas Link MRT Station' },
        'expo': { lat: 1.3354, lng: 103.9614, name: 'Expo MRT Station' },
        'pasir ris': { lat: 1.3729, lng: 103.9492, name: 'Pasir Ris MRT Station' }
    };
    
    const searchKey = address.toLowerCase().trim();
    
    // Check for exact matches first
    if (commonLocations[searchKey]) {
        const loc = commonLocations[searchKey];
        console.log(`   ✅ Found in local database: ${loc.name}`);
        return {
            latitude: loc.lat,
            longitude: loc.lng,
            address: loc.name,
            provider: 'Local Database'
        };
    }
    
    // Check for partial matches
    for (const [key, loc] of Object.entries(commonLocations)) {
        if (key.includes(searchKey) || searchKey.includes(key)) {
            console.log(`   ✅ Partial match found in local database: ${loc.name}`);
            return {
                latitude: loc.lat,
                longitude: loc.lng,
                address: loc.name,
                provider: 'Local Database (Partial Match)'
            };
        }
    }
    
    console.log('   ❌ No results found in any geocoding service');
    return null;
};

// Keyboard creation
const createMainKeyboard = () => ({
    keyboard: [
        [{ text: '📍 Share Location', request_location: true }],
        [{ text: '🔍 Search Address' }, { text: '🔄 Refresh' }],
        [{ text: '⚙️ Settings' }, { text: '❓ Help' }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
});

const createRefreshKeyboard = () => ({
    inline_keyboard: [
        [{ text: '🔄 Refresh All Arrivals', callback_data: 'refresh_all' }],
        [{ text: '📍 New Location Search', callback_data: 'new_search' }]
    ]
});

// Bot Commands

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'there';
    
    console.log(`👤 User ${userName} (${chatId}) started the bot`);
    
    const welcomeMessage = 
        `🚌 *Welcome to Singapore Bus Bot, ${userName}!*\n\n` +
        `I help you find nearby bus stops and get real-time bus arrival information.\n\n` +
        `*🆕 Enhanced Features:*\n` +
        `• 📍 Increased search radius to ${SEARCH_RADIUS}m\n` +
        `• 📱 Combined bus stop display\n` +
        `• 🔍 Address search functionality\n` +
        `• ⚙️ Customizable settings\n\n` +
        `*How to use:*\n` +
        `1️⃣ Share your location OR search by address\n` +
        `2️⃣ View all nearby bus stops in one message\n` +
        `3️⃣ See real-time arrivals with load status\n` +
        `4️⃣ Use refresh button to update timing\n\n` +
        `Ready to find your bus? Choose an option below! 🚌`;

    await bot.sendMessage(chatId, welcomeMessage, {
        parse_mode: 'Markdown',
        reply_markup: createMainKeyboard()
    });
});

// Complete file content (rest remains the same)
