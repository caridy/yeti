var ui = require("./ui");
var visitor = require("./visitor");
var server = require("./server");
var http = require("./http");
var signal = require("./signal");

exports.boot = function (config) {

    ui.verbose(config.verbose);

    config.forceVisit = !!config.browsers;

    if (
        "string" !== typeof config.browsers
    ) config.browsers = require("./browsers").Browser.canonical();

    config.browsers = config.browsers.split(",");

    if (config.quiet) ui.quiet(config.quiet);

    if (!config.host) config.host = "localhost";

    fromConfiguration(config);

};

function fromConfiguration (config) {
    var d = {
        host : config.host,
        port : config.port
    };

    d.method = "PUT";
    d.path = "/tests/add";
    d.body = { tests : visitor.composeURLs(
        "",
        config.path,
        config.files
    ) };

    if (config.delegate) {
        d.body.delegate = config.delegate;
        d.body.config = config;
        ui.log(ui.color.blue("[~]")
            + " Activating delegation for "+config.delegate);
    }

    var req = http.request(d);

    if (config.solo) {
        ui.start();
        var l = config.files.length;
        while (l--) ui.pending();
    }

    req.on("response", function (res, id) {
        ui.log("Waiting for results. When you're done, hit Ctrl-C to exit.");
        ui.debug("Batch registered:", id);
        d.method = "GET";
        d.path = "/status/" + id;
        (function moreResults () {
            http.request(d).on("response", function X (res, result) {
                if (res.statusCode === 200) {
                    ui.results(result);
                    moreResults();
                } else if (!d._404 && res.statusCode === 404) {
                    // perhaps the client hasn't connected yet?
                    d._404 = true;
                    return setTimeout(function () {
                        http.request(d).on("response", X);
                    }, 500);
                } else {
                    ui.exit("The server says: " + result);
                }
            });
        })();
    });

    req.on("error", function () {
        server.fromConfiguration(config);
        signal.listen();
    });
}

exports.fromConfiguration = fromConfiguration;
