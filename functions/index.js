'use strict';

process.env.DEBUG = 'actions-on-google:*';
const App = require('actions-on-google').ApiAiApp;
const functions = require('firebase-functions');
const firebaseAdmin = require('firebase-admin');
firebaseAdmin.initializeApp(functions.config().firebase);
const requestHttp = require('request');
const async = require('async');
const geolib = require('geolib');

const testLat = '59.938893';
const testLong = '10.722658';

const bikeRootUrl = 'https://oslobysykkel.no/api/v1';

const CLIENT_IDENTIFIER = 'f2f56a90378a3f11b77794a4640fca8a';

const WELCOME_ACTION = 'input.welcome';
const CLOSEST_BIKE_ACTION = 'closest_bike';
const REQUEST_LOCATION_ACTION = 'request_location';

// Entities/Firebase data keys
const LOCATION_DATA = 'location';

function encodeAsFirebaseKey (string) {
  return string.replace(/%/g, '%25')
        .replace(/\./g, '%2E')
        .replace(/#/g, '%23')
        .replace(/\$/g, '%24')
        .replace(/\//g, '%2F')
        .replace(/\[/g, '%5B')
        .replace(/\]/g, '%5D');
}

exports.yourAction = functions.https.onRequest((request, response) => {
  const app = new App({request, response});
  console.log('Request headers: ' + JSON.stringify(request.headers));
  console.log('Request body: ' + JSON.stringify(request.body));

  function requestLocationPermission (app) {
    let permission;
        // If the request comes from a phone, we can't use coarse location.
    permission = app.SupportedPermissions.DEVICE_PRECISE_LOCATION;
    app.data.permission = permission;
    return requestPermission(app, permission, LOCATION_DATA);
  }

  function requestPermission (app, permission, firebaseKey) {
    return new Promise(function (resolve, reject) {
      let userId = app.getUser().user_id;
      firebaseAdmin.database().ref('users/' + encodeAsFirebaseKey(userId))
                .once('value', function (data) {
                  if (data && data.val() && data.val()[firebaseKey]) {
                    resolve(callBikeAPI);
                  } else {
                    resolve(app.askForPermission('To find the closest bike', permission));
                  }
                });
    });
  }

  function callAvailableBikes (callback) {
    let availabilityMap = new Map();
    function callbackAvailableBikes (error, response, body) {
      if (error) {
        console.error(error);
      } else {
        let info = JSON.parse(body);
        info.stations.forEach(function (value) {
          availabilityMap.set(value.id, value.availability.bikes);
        });
      }
    }

    let options = {
      url: bikeRootUrl + '/stations/availability',
      headers: {
        'Client-Identifier': CLIENT_IDENTIFIER
      }
    };

    requestHttp(options, callbackAvailableBikes);
    callback(null, availabilityMap);
  }

  function combineAvailabilityStations (stationsList, availabilityMap) {
    let combinedArr = [];
    stationsList.forEach(function (station) {
      let availableBikes = availabilityMap.get(station.id);
      if (availableBikes > 0) {
        combinedArr.push(Object.assign(station, {availableBikes: availableBikes}));
      }
    });
    return combinedArr;
  }

  function sortArr (array) {
    array.sort(function (a, b) {
      return a.dist - b.dist;
    });
  }

  function mapToSortedDistanceList (body) {
    let myPos = {latitude: testLat, longitude: testLong};
    let sortedDistArr = [];
    let info = JSON.parse(body);
    console.log('Sorted arr: ' + sortedDistArr);
    info.stations.forEach(function (value) {
      let bikePos = {latitude: value.bounds[0].latitude, longitude: value.bounds[0].longitude};
                // Get distance
      let eDist = geolib.getDistance(myPos, bikePos);
      console.log('eDist is: ' + eDist);
      sortedDistArr.push({id: value.id, name: value.title + ' ' + value.subtitle, dist: eDist});
    }
        );
    sortArr(sortedDistArr);
    return sortedDistArr;
  }

  function callBikeAPI (app) {
    if (app.isPermissionGranted()) {
      let deviceCoordinates = app.getDeviceLocation().coordinates;
      async.parallel([
        getStations,
        callAvailableBikes
      ], function (err, result) {
        console.log('errors: ' + err);
        console.log('Result before combine: 0:' + result[0] + ' 1:' + result[1]);
        let combinedList = combineAvailabilityStations(result[0], result[1]);
        console.log(combinedList);
        app.tell('The closest station with bikes is ' + combinedList[0].name + '. It has ' + combinedList[0].availableBikes + ' bikes available');
      });
    } else {
      callBikeError(app);
    }
  }

  function getStations (callback) {
    function localCallback (error, response, body) {
      console.log('getStation callback' + body);
      if (!error && response.statusCode === 200) {
        callback(null, mapToSortedDistanceList(body));
      } else {
        console.log('error:', error); // Print the error if one occurred
        callback('error: ' + error, null);
      }
    }
    let options = {
      url: bikeRootUrl + '/stations',
      headers: {
        'Client-Identifier': CLIENT_IDENTIFIER
      }
    };

    requestHttp(options, localCallback);
  }

  function greetUser (app) {
    app.ask(`<speak>Welcome to city bike finder!</speak>`);
  }

  function callBikeError (app) {
        // User did not grant permission or reverse geocoding failed.
    app.tell(`<speak>I am sorry but I failed to find any nearby bikes.</speak>`);
  }

  const actionMap = new Map();
  actionMap.set(WELCOME_ACTION, greetUser);
  actionMap.set(CLOSEST_BIKE_ACTION, callBikeAPI);
  actionMap.set(REQUEST_LOCATION_ACTION, requestLocationPermission);

  app.handleRequest(actionMap);
});
