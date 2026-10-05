module.exports = function (config) {
  config.set({
    basePath: '',
    frameworks: ['jasmine', '@angular-devkit/build-angular'],
    plugins: [require('karma-jasmine'), require('karma-chrome-launcher'), require('karma-coverage')],
    reporters: ['progress'],
    coverageReporter: { dir: require('path').join(__dirname, './coverage/twitch-loop-web'), reporters: [{ type: 'html' }, { type: 'lcovonly' }, { type: 'text-summary' }] },
    customLaunchers: { ChromeHeadlessNoSandbox: { base: 'ChromeHeadless', flags: ['--no-sandbox', '--disable-dev-shm-usage'] } },
    browsers: ['ChromeHeadlessNoSandbox'],
    singleRun: true,
    restartOnFileChange: false
  });
};
