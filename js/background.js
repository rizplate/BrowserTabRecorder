/* Required: 
 *  js/third_party/whammy.js
 *  js/third_party/gifshot.min.js
 *  js/videoRecorder.js
 *  js/audioRecorder.js
 */

// Constants
var MANIFEST = chrome.runtime.getManifest()     // Manifest reference
;
console.log('Initializing Bug-Filer v' + MANIFEST.version, 
        chrome.i18n.getMessage('@@ui_locale'));

// Variables
var popupConnection = null              // Handle for port connection to popup
    , videoConnection = null            // Handle for video capture stream
    , videoRecorder = VideoRecorder   // Reference to video recording object
;


//////////////////////////////////////////////////////////
// ACTIONS

// Listen for events from popup
chrome.extension.onConnect.addListener(function(port) 
{
    console.log("Connected to port:", port);
    popupConnection = port;

    port.onMessage.addListener(function(message) 
    {
	    console.log("message:", message);

        switch (message.request)
        {
            case "captureTabScreenshot":
                captureTabScreenshot(message);
                break;

            case "captureTabGif":
                sendMessageToActiveTab(message);
                break;

            case "captureTabVideo":
                sendMessageToActiveTab(message);
                break;

            case "captureTabAudio":
                sendMessageToActiveTab(message);
                break;

            default:  // For actions & plugins, push to active tab
                sendMessageToActiveTab(message);
                break;
        }
    });
});

// Listen for events from content script
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) 
{
    console.log('sender:', sender);
    console.log('message:', message.request);

    // Handle message
    switch (message.request)
    {  
        case "downloadContent":
            initiateDownload(message.filename, message.contentURL);
            break;

        case "startGifRecording":
        case "startVideoRecording":
            captureTabVideo(sender.tab.id);
            break;

        case "stopVideoRecording":
            stopVideoCapture(sender.tab.id);
            break;

        case "stopGifRecording":
            stopVideoCapture(sender.tab.id, convertVideoToGif);
            break;

        case "videoRecordingStatus":
            sendResponse({
                request: "recordingStatus",
                stream: videoConnection,
            });
            break;

        case "convertVideoToGif":
            convertVideoToGif(message, sender.tab.id);
            break;

        case "updatePopup":     // Tell popup to update its fields
            if (popupConnection) {
                popupConnection.postMessage({request: "update"});
            }
            break;

        default:
            console.log("Unknown request received!");
            break;
    }
});

// On first install or upgrade
chrome.runtime.onInstalled.addListener(function(details)
{
	console.log("onInstalled: " + details.reason);

    // On first install
	if (details.reason == "install") {
        //chrome.tabs.create({url: "options.html"});  // Open up options page
	}

	// If upgrading to new version number
    else if (details.reason == "update" && details.previousVersion != MANIFEST.version) {
        // Do nothing?
	}

    // All other - probably reloaded extension
    else {
        //runTests();
    }
});


//////////////////////////////////////////////////////////
// TESTING

function runTests()
{
    /*
    testVersionMismatch(function() {
        // Do nothing
    });
    // */
}


//////////////////////////////////////////////////////////
// FUNCTIONS

// Send message to active tab
function sendMessageToActiveTab(message)
{
    console.log('sendMessageToActiveTab:', message);

    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        chrome.tabs.sendMessage(tabs[0].id, message, function(response) {
            console.log('response:', response);
        });
    });
}

// Capture screenshot from the current active tab
function captureTabScreenshot(data)
{
    console.log('captureTabScreenshot');

    chrome.tabs.captureVisibleTab(null, {
        format: "png"
    }, 
    function (dataSourceURL) 
    {
        console.log("source:", dataSourceURL);

        // Send to active tab if capture was successful
        if (dataSourceURL) 
        {
            data.sourceURL = dataSourceURL;
            sendMessageToActiveTab(data);
        } 
        else    // Failed
        {
            console.log("ERROR: could not capture screenshot")
            console.log(chrome.runtime.lastError);
        }
    });
}

// Capture video stream of tab, will pass stream back to sendResponse()
function captureTabVideo(senderTabId)
{
    console.log("captureTabVideo");

    // Sanity check, can only record one at a time
    if (videoConnection) 
    {
        console.log('ERROR: video stream already exists, cannot capture two at a time!');
        chrome.tabs.sendMessage(senderTabId, {
            request: 'videoRecordingStarted',
            stream: null
        });
        return;
    }

    // Get video options
    chrome.storage.sync.get(KEY_STORAGE_SETTINGS, function (data) 
    {
        var settings;

        // Sanity check
        if (chrome.runtime.lastError) 
        {
            console.log(chrome.runtime.lastError);
            settings = {};
        } 
        else {   // Success, update settings
            settings = data[KEY_STORAGE_SETTINGS];
        }
        var videoSettings = {
            mandatory: {
                minWidth: settings['videoWidthSetting'] || DEFAULT_VIDEO_WIDTH,
                minHeight: settings['videoHeightSetting'] || DEFAULT_VIDEO_HEIGHT,
                maxWidth: settings['videoWidthSetting'] || DEFAULT_VIDEO_WIDTH,
                maxHeight: settings['videoHeightSetting'] || DEFAULT_VIDEO_HEIGHT,
                chromeMediaSource: 'tab'
            }
        };

    });

    // Capture only video from the tab
    chrome.tabCapture.capture({
            audio: false,
            video: true,
            videoConstraints: videoSettings
        }, 
        function (localMediaStream) 
        {
            console.log('tabCapture:', localMediaStream);

            // Send to active tab if capture was successful
            if (localMediaStream)
            {
                // Store stream for reference
                videoConnection = localMediaStream;

                // Start recording
                if (!videoRecorder.start(videoConnection))
                {
                    console.log('ERROR: could not start video recorder');
                    videoConnection = null;
                }
            }
            else    // Failed
            {
                console.log("ERROR: could not capture video stream")
                console.log(chrome.runtime.lastError);
                videoConnection = null;
            }

            // Send to response
            chrome.tabs.sendMessage(senderTabId, {
                request: 'videoRecordingStarted',
                stream: videoConnection
            });
        });
}

// Stop video capture and build compiled .webm video file
//  If callback DNE, send video to active page, otherwise pass along video to callback
function stopVideoCapture(senderTabId, callback)
{
    console.log("stopVideoCapture");

    // Sanity check
    if (!videoConnection) 
    {
        videoConnection = null;
        chrome.tabs.sendMessage(senderTabId, {
            request: 'videoRecordingStopped',
            sourceURL: null,
        });
        return;
    }

    // Stop video capture and save file
    var videoData = videoRecorder.stop();
    videoConnection = null;

    // If output was bad, don't continue
    if (!videoData || !videoData.sourceURL) 
    {
        chrome.tabs.sendMessage(senderTabId, {
            request: 'videoRecordingStopped',
            sourceURL: null,
        });
        return;
    }

    // If callback exists, pass parameters
    if (callback) {
        callback(videoData, senderTabId);
    } 
    else    // Pass video to active tab
    {
        chrome.tabs.sendMessage(senderTabId, {
            request: 'videoRecordingStopped',
            sourceURL: videoData.sourceURL,
        });
    }
}

// Convert video file to gif
function convertVideoToGif(videoData, senderTabId)
{
    console.log("convertVideoToGif:", videoData);

    // Santity check
    if (!videoData || !videoData.sourceURL) 
    {
        chrome.tabs.sendMessage(senderTabId, {
            request: 'convertedGif',
            sourceURL: null,
        });
        return;
    }

    // Collect option
    var options = {
        gifWidth: (videoData.width || 640),
        gifHeight: (videoData.height || 480),
        numFrames: (videoData.length || 2) * 10,
        video: [videoData.sourceURL],
    };
    console.log('options:', options);

    // Using gifshot library to generate gif from video
    gifshot.createGIF(options, 
        function (obj) 
        {
            var src = null;
            if (!obj.error) {
                src = obj.image;    // Set src
            } else {
                console.log(obj.error);
            }

            // Send to active tab if senderTabId is not set
            chrome.tabs.sendMessage(senderTabId, {
                request: 'convertedGif',
                sourceURL: src
            });
        });
}

// Initiate download of something
function initiateDownload(filename, contentURL)
{
    console.log('initiateDownload:', filename);

    // Create download link
    var link = document.createElement('a');
    link.href = contentURL;
    link.download = filename;

    // Create fake click
    var click = document.createEvent("Event");
    click.initEvent("click", true, true);
    link.dispatchEvent(click);
}


