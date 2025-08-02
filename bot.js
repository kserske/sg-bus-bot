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

// Geocoding function for address search
const geocodeAddress = async (address) => {
    try {
        // Using OneMap API (Singapore's official mapping service)
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
            return {
                latitude: parseFloat(result.LATITUDE),
                longitude: parseFloat(result.LONGITUDE),
                address: result.ADDRESS || result.SEARCHVAL
            };
        }
        
        return null;
    } catch (error) {
        console.error('Geocoding error:', error.message);
        return null;
    }
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

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    
    const helpMessage = 
        `❓ *Singapore Bus Bot Help*\n\n` +
        `*Available Commands:*\n` +
        `• /start - Start the bot\n` +
        `• /help - Show this help message\n` +
        `• /location - Request location sharing\n` +
        `• /search - Search by address\n` +
        `• /settings - Adjust preferences\n` +
        `• /debug - System status\n` +
        `• /test - Test API connection\n\n` +
        `*Features:*\n` +
        `📍 Share your GPS location for instant results\n` +
        `🔍 Search by typing any Singapore address\n` +
        `📱 All nearby stops shown in one message\n` +
        `🔄 Real-time arrival updates\n` +
        `⚙️ Customizable search radius\n\n` +
        `*Tips:*\n` +
        `• For address search, be specific (e.g., "Orchard Road MRT")\n` +
        `• Bus timings are updated every 30 seconds\n` +
        `• Load indicators: 🟢 Seats, 🟡 Standing, 🔴 Limited\n\n` +
        `Need more help? Contact support or try /debug for troubleshooting.`;

    await bot.sendMessage(chatId, helpMessage, { 
        parse_mode: 'Markdown',
        reply_markup: createMainKeyboard()
    });
});

bot.onText(/\/location/, async (msg) => {
    const chatId = msg.chat.id;
    
    await bot.sendMessage(chatId, 
        '📍 Please share your location to find nearby bus stops:', {
        reply_markup: {
            keyboard: [[{ text: '📍 Share My Location', request_location: true }]],
            resize_keyboard: true,
            one_time_keyboard: true
        }
    });
});

bot.onText(/\/search/, async (msg) => {
    const chatId = msg.chat.id;
    
    await bot.sendMessage(chatId, 
        `🔍 *Address Search*\n\n` +
        `Type any Singapore address, landmark, or MRT station name.\n\n` +
        `*Examples:*\n` +
        `• "Marina Bay Sands"\n` +
        `• "Orchard Road MRT"\n` +
        `• "Raffles Place"\n` +
        `• "313 Somerset"\n\n` +
        `Just type your location below:`, 
        { parse_mode: 'Markdown' }
    );
    
    // Set user state for address search
    userSessions.set(chatId, { 
        ...userSessions.get(chatId),
        waitingForAddress: true 
    });
});

bot.onText(/\/settings/, async (msg) => {
    const chatId = msg.chat.id;
    const prefs = userPreferences.get(chatId) || { radius: SEARCH_RADIUS, maxStops: MAX_BUS_STOPS };
    
    const settingsKeyboard = {
        inline_keyboard: [
            [
                { text: `Radius: ${prefs.radius}m`, callback_data: 'setting_radius' },
                { text: `Max Stops: ${prefs.maxStops}`, callback_data: 'setting_stops' }
            ],
            [{ text: '🔄 Reset to Default', callback_data: 'setting_reset' }],
            [{ text: '✅ Done', callback_data: 'setting_done' }]
        ]
    };
    
    await bot.sendMessage(chatId, 
        `⚙️ *Settings*\n\n` +
        `Current preferences:\n` +
        `• Search Radius: ${prefs.radius}m\n` +
        `• Max Bus Stops: ${prefs.maxStops}\n\n` +
        `Tap to adjust:`, 
        { 
            parse_mode: 'Markdown',
            reply_markup: settingsKeyboard
        }
    );
});

// Enhanced debug command with more diagnostic info
bot.onText(/\/debug/, async (msg) => {
    const chatId = msg.chat.id;
    
    const debugInfo = 
        `🔧 *Debug Information*\n\n` +
        `*System Status:*\n` +
        `• Environment: ${NODE_ENV}\n` +
        `• API Endpoint: ${WORKING_API_ENDPOINT ? WORKING_API_ENDPOINT : '❌ Not connected'}\n` +
        `• Bot Token: ${BOT_TOKEN ? 'Set ✅' : 'Missing ❌'}\n` +
        `• LTA API Key: ${LTA_API_KEY ? `Set ✅ (${LTA_API_KEY.substring(0, 8)}...)` : 'Missing ❌'}\n\n` +
        `*Cache Status:*\n` +
        `• Bus Stops Cached: ${busStopsCache.data.length}\n` +
        `• Last Updated: ${busStopsCache.lastUpdated ? new Date(busStopsCache.lastUpdated).toLocaleString() : 'Never'}\n` +
        `• Cache Age: ${busStopsCache.lastUpdated ? Math.round((Date.now() - busStopsCache.lastUpdated) / 60000) + ' minutes' : 'N/A'}\n\n` +
        `*Configuration:*\n` +
        `• Search Radius: ${SEARCH_RADIUS}m\n` +
        `• Max Bus Stops: ${MAX_BUS_STOPS}\n` +
        `• Request Timeout: ${REQUEST_TIMEOUT}ms\n\n` +
        `*API Endpoints Available:*\n` +
        Object.entries(API_ENDPOINTS).map(([name, url]) => `• ${name}: ${url}`).join('\n') + '\n\n' +
        `*Active Sessions:* ${userSessions.size}\n` +
        `*User Preferences:* ${userPreferences.size}`;

    await bot.sendMessage(chatId, debugInfo, { parse_mode: 'Markdown' });
});

bot.onText(/\/test/, async (msg) => {
    const chatId = msg.chat.id;
    
    const testMsg = await bot.sendMessage(chatId, '🧪 Testing API connection...');
    
    const workingEndpoint = await testAPIConnection();
    
    if (workingEndpoint) {
        WORKING_API_ENDPOINT = workingEndpoint;
        await bot.editMessageText(
            `✅ *API Connection Successful!*\n\n` +
            `Endpoint: ${workingEndpoint}\n` +
            `Status: Ready for bus data retrieval`, {
            chat_id: chatId,
            message_id: testMsg.message_id,
            parse_mode: 'Markdown'
        });
    } else {
        await bot.editMessageText(
            `❌ *API Connection Failed*\n\n` +
            `All endpoints are unreachable.\n` +
            `Please check:\n` +
            `• Internet connection\n` +
            `• LTA API key validity\n` +
            `• API service status`, {
            chat_id: chatId,
            message_id: testMsg.message_id,
            parse_mode: 'Markdown'
        });
    }
});

// Text message handler for address search
bot.on('text', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    // Skip if it's a command
    if (text.startsWith('/')) return;
    
    const session = userSessions.get(chatId);
    
    // Handle button presses
    if (text === '🔍 Search Address') {
        await bot.sendMessage(chatId, 
            `🔍 *Address Search*\n\n` +
            `Type any Singapore address, landmark, or MRT station name.\n\n` +
            `*Examples:*\n` +
            `• "Marina Bay Sands"\n` +
            `• "Orchard Road MRT"\n` +
            `• "Raffles Place"\n` +
            `• "313 Somerset"\n\n` +
            `Just type your location below:`, 
            { parse_mode: 'Markdown' }
        );
        userSessions.set(chatId, { ...session, waitingForAddress: true });
        return;
    }
    
    if (text === '🔄 Refresh' && session && session.latitude && session.longitude) {
        await handleLocationSearch(chatId, session.latitude, session.longitude, 'Refreshing bus arrivals...');
        return;
    }
    
    if (text === '⚙️ Settings') {
        bot.emit('message', { ...msg, text: '/settings' });
        return;
    }
    
    if (text === '❓ Help') {
        bot.emit('message', { ...msg, text: '/help' });
        return;
    }
    
    // Handle address search
    if (session && session.waitingForAddress) {
        const searchMsg = await bot.sendMessage(chatId, `🔍 Searching for "${text}"...`);
        
        try {
            const location = await geocodeAddress(text);
            
            if (location) {
                await bot.editMessageText(
                    `📍 Found: ${location.address}\n🔍 Searching for nearby bus stops...`, {
                    chat_id: chatId,
                    message_id: searchMsg.message_id
                });
                
                // Clear the address search state
                userSessions.set(chatId, { 
                    ...session, 
                    waitingForAddress: false,
                    latitude: location.latitude,
                    longitude: location.longitude,
                    searchedAddress: location.address
                });
                
                await bot.deleteMessage(chatId, searchMsg.message_id);
                await handleLocationSearch(chatId, location.latitude, location.longitude, 
                    `📍 Results for: ${location.address}\n🔍 Loading bus stops...`);
                
            } else {
                await bot.editMessageText(
                    `❌ Location "${text}" not found.\n\n` +
                    `Please try:\n` +
                    `• A more specific address\n` +
                    `• Adding "Singapore" to your search\n` +
                    `• Using landmarks or MRT station names`, {
                    chat_id: chatId,
                    message_id: searchMsg.message_id
                });
                
                // Keep the address search state active
            }
        } catch (error) {
            console.error('Address search error:', error);
            await bot.editMessageText(
                `❌ Search failed. Please try again or use GPS location instead.`, {
                chat_id: chatId,
                message_id: searchMsg.message_id
            });
        }
    }
});

// Location handler
const handleLocationSearch = async (chatId, latitude, longitude, initialMessage) => {
    const searchingMsg = await bot.sendMessage(chatId, initialMessage);

    try {
        userSessions.set(chatId, { 
            ...userSessions.get(chatId),
            latitude, 
            longitude, 
            timestamp: Date.now(),
            waitingForAddress: false
        });

        const busStopsData = busStopsCache.data.length > 0 ? busStopsCache.data : await getAllBusStops();
        
        if (busStopsData.length === 0) {
            await bot.editMessageText(
                '❌ Unable to load bus stops data. Please try /test to check API connection.', {
                chat_id: chatId,
                message_id: searchingMsg.message_id
            });
            return;
        }

        const userPrefs = userPreferences.get(chatId) || { radius: SEARCH_RADIUS, maxStops: MAX_BUS_STOPS };
        const nearbyStops = findNearbyBusStops(latitude, longitude, busStopsData, userPrefs.radius);

        if (nearbyStops.length === 0) {
            await bot.editMessageText(
                `❌ No bus stops found within ${userPrefs.radius} meters.\n\n` +
                `Try:\n` +
                `• Increasing search radius in /settings\n` +
                `• Moving to a different location\n` +
                `• Using /debug for system status`, {
                chat_id: chatId,
                message_id: searchingMsg.message_id
            });
            return;
        }

        await bot.editMessageText(
            `📍 Found ${nearbyStops.length} bus stop${nearbyStops.length > 1 ? 's' : ''} nearby.\n` +
            `🔄 Loading real-time arrivals...`, {
            chat_id: chatId,
            message_id: searchingMsg.message_id
        });

        const combinedMessage = await formatCombinedBusArrivalsMessage(nearbyStops.slice(0, userPrefs.maxStops));
        
        await bot.editMessageText(combinedMessage, {
            chat_id: chatId,
            message_id: searchingMsg.message_id,
            parse_mode: 'Markdown',
            reply_markup: createRefreshKeyboard()
        });

    } catch (error) {
        console.error('Error processing location:', error);
        await bot.editMessageText(
            '❌ An error occurred while searching. Use /debug for more info.', {
            chat_id: chatId,
            message_id: searchingMsg.message_id
        });
    }
};

bot.on('location', async (msg) => {
    const chatId = msg.chat.id;
    const { latitude, longitude } = msg.location;

    console.log(`📍 Location received from user ${chatId}: (${latitude}, ${longitude})`);
    await handleLocationSearch(chatId, latitude, longitude, '🔍 Searching for nearby bus stops...');
});

// Callback query handler
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;

    console.log(`🔘 Callback query from user ${chatId}: ${data}`);

    try {
        if (data === 'refresh_all') {
            const userSession = userSessions.get(chatId);
            if (!userSession || !userSession.latitude || !userSession.longitude) {
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: '❌ No location data. Please search again.',
                    show_alert: true
                });
                return;
            }

            await bot.editMessageText('🔄 Refreshing all bus arrivals...', {
                chat_id: chatId,
                message_id: messageId
            });

            const userPrefs = userPreferences.get(chatId) || { radius: SEARCH_RADIUS, maxStops: MAX_BUS_STOPS };
            const busStopsData = busStopsCache.data;
            const nearbyStops = findNearbyBusStops(
                userSession.latitude, 
                userSession.longitude, 
                busStopsData,
                userPrefs.radius
            );

            if (nearbyStops.length === 0) {
                await bot.editMessageText(
                    `❌ No bus stops found within ${userPrefs.radius} meters.`, {
                    chat_id: chatId,
                    message_id: messageId
                });
                return;
            }

            const combinedMessage = await formatCombinedBusArrivalsMessage(nearbyStops.slice(0, userPrefs.maxStops));
            
            await bot.editMessageText(combinedMessage, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: createRefreshKeyboard()
            });
            
        } else if (data === 'new_search') {
            await bot.sendMessage(chatId, 
                '📍 Choose how to search for bus stops:', {
                reply_markup: createMainKeyboard()
            });
            
        } else if (data.startsWith('setting_')) {
            const setting = data.replace('setting_', '');
            const prefs = userPreferences.get(chatId) || { radius: SEARCH_RADIUS, maxStops: MAX_BUS_STOPS };
            
            if (setting === 'radius') {
                const radiusKeyboard = {
                    inline_keyboard: [
                        [
                            { text: '100m', callback_data: 'radius_100' },
                            { text: '200m', callback_data: 'radius_200' },
                            { text: '300m', callback_data: 'radius_300' }
                        ],
                        [
                            { text: '400m', callback_data: 'radius_400' },
                            { text: '500m', callback_data: 'radius_500' },
                            { text: '750m', callback_data: 'radius_750' }
                        ],
                        [{ text: '← Back to Settings', callback_data: 'setting_back' }]
                    ]
                };
                
                await bot.editMessageText(
                    `🎯 *Search Radius*\n\n` +
                    `Current: ${prefs.radius}m\n\n` +
                    `Choose new radius:`, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: radiusKeyboard
                });
                
            } else if (setting === 'stops') {
                const stopsKeyboard = {
                    inline_keyboard: [
                        [
                            { text: '3 stops', callback_data: 'stops_3' },
                            { text: '5 stops', callback_data: 'stops_5' },
                            { text: '7 stops', callback_data: 'stops_7' }
                        ],
                        [
                            { text: '10 stops', callback_data: 'stops_10' },
                            { text: '15 stops', callback_data: 'stops_15' }
                        ],
                        [{ text: '← Back to Settings', callback_data: 'setting_back' }]
                    ]
                };
                
                await bot.editMessageText(
                    `📊 *Maximum Bus Stops*\n\n` +
                    `Current: ${prefs.maxStops} stops\n\n` +
                    `Choose maximum number of stops to display:`, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: stopsKeyboard
                });
                
            } else if (setting === 'reset') {
                userPreferences.set(chatId, { radius: SEARCH_RADIUS, maxStops: MAX_BUS_STOPS });
                
                await bot.editMessageText(
                    `✅ *Settings Reset*\n\n` +
                    `Restored to default values:\n` +
                    `• Search Radius: ${SEARCH_RADIUS}m\n` +
                    `• Max Bus Stops: ${MAX_BUS_STOPS}`, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: '← Back to Settings', callback_data: 'setting_back' }]]
                    }
                });
                
            } else if (setting === 'done' || setting === 'back') {
                const currentPrefs = userPreferences.get(chatId) || { radius: SEARCH_RADIUS, maxStops: MAX_BUS_STOPS };
                
                const settingsKeyboard = {
                    inline_keyboard: [
                        [
                            { text: `Radius: ${currentPrefs.radius}m`, callback_data: 'setting_radius' },
                            { text: `Max Stops: ${currentPrefs.maxStops}`, callback_data: 'setting_stops' }
                        ],
                        [{ text: '🔄 Reset to Default', callback_data: 'setting_reset' }],
                        [{ text: '✅ Done', callback_data: 'setting_done' }]
                    ]
                };
                
                if (setting === 'done') {
                    await bot.editMessageText(
                        `✅ *Settings Saved*\n\n` +
                        `Your preferences:\n` +
                        `• Search Radius: ${currentPrefs.radius}m\n` +
                        `• Max Bus Stops: ${currentPrefs.maxStops}\n\n` +
                        `Use the menu below to search for bus stops!`, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'Markdown'
                    });
                    
                    // Send new message with main keyboard
                    setTimeout(() => {
                        bot.sendMessage(chatId, '🚌 Ready to search for buses!', {
                            reply_markup: createMainKeyboard()
                        });
                    }, 1000);
                } else {
                    await bot.editMessageText(
                        `⚙️ *Settings*\n\n` +
                        `Current preferences:\n` +
                        `• Search Radius: ${currentPrefs.radius}m\n` +
                        `• Max Bus Stops: ${currentPrefs.maxStops}\n\n` +
                        `Tap to adjust:`, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'Markdown',
                        reply_markup: settingsKeyboard
                    });
                }
            }
            
        } else if (data.startsWith('radius_')) {
            const radius = parseInt(data.replace('radius_', ''));
            const prefs = userPreferences.get(chatId) || { radius: SEARCH_RADIUS, maxStops: MAX_BUS_STOPS };
            prefs.radius = radius;
            userPreferences.set(chatId, prefs);
            
            await bot.editMessageText(
                `✅ *Search Radius Updated*\n\n` +
                `New radius: ${radius}m\n\n` +
                `This will affect future searches.`, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '← Back to Settings', callback_data: 'setting_back' }]]
                }
            });
            
        } else if (data.startsWith('stops_')) {
            const maxStops = parseInt(data.replace('stops_', ''));
            const prefs = userPreferences.get(chatId) || { radius: SEARCH_RADIUS, maxStops: MAX_BUS_STOPS };
            prefs.maxStops = maxStops;
            userPreferences.set(chatId, prefs);
            
            await bot.editMessageText(
                `✅ *Maximum Stops Updated*\n\n` +
                `New limit: ${maxStops} stops\n\n` +
                `This will affect future searches.`, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '← Back to Settings', callback_data: 'setting_back' }]]
                }
            });
        }

        await bot.answerCallbackQuery(callbackQuery.id, {
            text: '✅ Updated!'
        });

    } catch (error) {
        console.error('Error handling callback:', error);
        await bot.answerCallbackQuery(callbackQuery.id, {
            text: '❌ Update failed. Please try again.',
            show_alert: true
        });
    }
});

// Error handlers
bot.on('error', (error) => {
    console.error('❌ Bot error:', error.message);
});

bot.on('polling_error', (error) => {
    console.error('❌ Polling error:', error.message);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 Shutting down Singapore Bus Bot...');
    bot.stopPolling();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('🛑 Shutting down Singapore Bus Bot...');
    bot.stopPolling();
    process.exit(0);
});

// Initialize and start
const initializeBot = async () => {
    try {
        console.log('🚀 Starting Enhanced Singapore Bus Bot...');
        console.log(`📝 Environment: ${NODE_ENV}`);
        console.log(`🎯 Search Radius: ${SEARCH_RADIUS}m`);
        console.log(`📊 Max Bus Stops: ${MAX_BUS_STOPS}`);
        
        // Test API connection first
        WORKING_API_ENDPOINT = await testAPIConnection();
        
        if (!WORKING_API_ENDPOINT) {
            console.error('❌ No working API endpoint found!');
            console.error('🔧 Troubleshooting steps:');
            console.error('   1. Check your LTA_API_KEY in .env file');
            console.error('   2. Verify your API key at https://datamall.lta.gov.sg');
            console.error('   3. Check if your API key is activated');
            console.error('   4. Try running /test command in the bot');
            console.error('');
            console.error('⚠️  Bot will start but bus data will not work until API is fixed');
        } else {
            console.log('✅ API connection successful');
            // Pre-load bus stops data
            console.log('📊 Pre-loading bus stops data...');
            await getAllBusStops();
            console.log('✅ Bus stops data loaded');
        }
        
        console.log('✅ Enhanced Singapore Bus Bot is running!');
        console.log('💡 New Features:');
        console.log('   • 📍 200m search radius');
        console.log('   • 🔍 Address search with OneMap');
        console.log('   • 📱 Combined bus stop display');
        console.log('   • ⚙️ User customizable settings');
        console.log('   • 🔄 Enhanced refresh functionality');
        console.log('');
        console.log('🤖 Bot commands menu configured');
        console.log('📞 Ready for user interactions!');
        
    } catch (error) {
        console.error('❌ Failed to initialize bot:', error.message);
        console.error('Stack trace:', error.stack);
        process.exit(1);
    }
};

// Start the enhanced bot
initializeBot();
            
