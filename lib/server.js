var express = require("express");
var connect = require("connect");
var http = require("http");

var sendfiles = require("./sendfiles").sendfiles;
var ui = require("./ui");
var visitor = require("./visitor");

var tests = new (require("events").EventEmitter);

function makeId () {
    return (Math.random() * 0x1000000|0) + "";
}

var cachebuster = makeId();

function serveExpress (port, path, cb) {

    var app = express.createServer(
        connect.methodOverride(),
        connect.bodyDecoder()
    );

    app.set("views", __dirname + "/views");
    app.set("view engine", "jade");

    app.get("/", function(req, res){
        res.render("index");
    });

    var testIds = {};
    var testResults = {};
    var testQueue = {};
    var testDelegate = {};

    app.put("/tests/add", function (req, res) {
        if (!req.body.tests.length) return res.send(500);

        var urls = [];
        var id = req.body.id || makeId(); // using a fixed ID if posible
        var remote = (req.body.remote ? req.body.remote : '');
        
        req.body.tests.forEach(function (url) {
            urls.push( remote + "/project/" + id + url ); // supporting remote testing
        });
        ui.debug("/tests/add: registered batch", id);

        if (tests.listeners("add").length) {
            tests.emit("add", id, urls);
        } else {
            testQueue[id] = urls;
        }

        res.send(id);

        // if delegate is on, let's submit the same tests to a remote yeti instance
        if (req.body.delegate) {
            propagateTests (req.body.delegate, id, req.body);
        }
        // for monitoring remote invocations only
        if (req.body.remote) {
            console.log ('Receiving tests from '+req.body.remote);
        }
    });

    function wait (req, responseCallback) {
        var cb = function (id, urls) {
            ui.debug("/tests/wait: send", urls);
            responseCallback({
                tests : urls
            });
            testIds[id] = 1;
        };
        tests.on("add", cb);
        req.on("end", function () {
            tests.removeListener("add", cb);
        });
        if (testQueue) {
            for (
                var id in testQueue
            ) tests.emit("add", id, testQueue[id]);
            testQueue = [];
        }
    }

    app.get("/tests/wait", function (req, res) {
        res.writeHead(200, {
            "Content-Type" : "text/event-stream"
        });
        wait(req, function (data) {
            res.write("data: " + JSON.stringify(data) + "\n\n");
        });
    });

    app.post("/tests/wait", function (req, res) {
        wait(req, function (data) {
            res.send(data);
            req.emit("end"); // will remove add listener
        });
    });

    app.get("/status/:id", function (req, res, params) {
        if ((params.id in testIds)) {
            tests.on(params.id, function (results) {
                res.send(results);
            });
        } else if (params.id in testDelegate) {
            // if there isn't any browser but delegate is on, we can wait for the result as well.
            res.writeHead(200, {
                "Content-Type" : "text/event-stream"
            });
            wait(req, function (data) {
                res.write("data: " + JSON.stringify(data) + "\n\n");
            });
        } else {
            delete testQueue[params.id];
            res.send("Nothing is listening to this batch. At least one browser should be pointed at the Yeti server.", 404);
        }
    });

    app.post("/results", function (req, res) {
        var result = JSON.parse(req.body.results);
        result.ua = req.body.useragent;
        var id = req.body.id;

        ui.debug("/results:", id, " has results from: " + result.ua);

        if (id in testIds) {
            if ( ! (id in testResults) ) {
                testResults[id] = [];
            }
            testResults[id].push(result);
            tests.emit(id, result);
        } else {
            ui.results(result);
        }

        res.send(200);
    });

    var projectSend = function (res, file, appendString, nocache) {
        sendfiles.call(
            res,
            [file],
            appendString,
            null, // callback
            {
                cache : !nocache
            }
        );
    };

    app.get('/project/*', function (req, res, params) {

        // TODO: fix test
        // that causes us to normalize leading slashes
        var nocache = false;
        var splat = params.splat.pop().split("/");
        var id = splat[0];
        // maybe there is not a local browser, but delegate can do it, so
        // testQueue is a reliable way to check if there is any pending test
        if ((id in testIds) || (id in testQueue)) {
            splat.shift();
            nocache = true; // using a unique url
        }
        if (splat[0] === "") splat.shift(); // stupid leading slashes
        splat = splat.join("/");

        var file = "/" + splat;

        // the requested file must begin with our cwd
        if (file.indexOf(path) !== 0) {
            // the file is outside of our cwd
            // reject the request
            ui.log(ui.color.red("[!]")
                + " Rejected " + file
                + ", run in the directory to serve"
                + " or specify --path.");
            return res.send(403);
        }

        if (/^.*\.html?$/.test(req.url)) {
            // maybe we need delegate
            var delegate = ((id && (id in testDelegate))?testDelegate[id]:'');
            // inject a test reporter into the test page
            projectSend(
                res, file,
                "<script src=\"/dyn/" + cachebuster
                + "/inject.js\"></script><script>"
                + "$yetify({url:'/results',delegate:'"+delegate+"'});</script>",
                nocache
            );
        } else {
            // everything else goes untouched
            projectSend(res, file, "", nocache);
        }

    });

    var incSend = function (res, name, nocache) {
        sendfiles.call(
            res,
            [__dirname + "/../inc/" + name],
            "", // appendString
            null, // callback
            {
                cache : !nocache
            }
        );
    };

    app.get("/inc/*", function (req, res, params) {
        incSend(res, params.splat);
    });

    app.get("/dyn/:cachebuster/*", function (req, res, params) {
        incSend(res, params.splat, true);
    });

    app.get("/favicon.ico", function (req, res) {
        incSend(res, "favicon.ico", true);
    });

    function propagateTests (remote_config, id, proxy) {
        testDelegate[id] = remote_config;
        console.log ('Propagating tests to http://'+remote_config);
        remote_config = remote_config.split(':');
        
        var d = {
            host : remote_config[0],
            port : remote_config[1]
        };

        d.method = "PUT";
        d.path = "/tests/add";
        d.body = { 
            tests : proxy.tests,
            remote: 'http://' +  proxy.config.host + ':' + proxy.config.port,
            id: id
        };

        var req = require("./http").request(d);

        req.on("error", function () {
            console.log("Propagation Fails" );
        });

    }

    app.get("/tests/next", function (req, res) {
        res.writeHead(200, {
            "Content-Type" : "text/html"
        });
        res.write("<script>try { parent.YETI.next(); } catch (e) {};</script>");
        res.end();
    });

    // workaround express and connect bugs
    // that strip out the host and callback args!
    // n.b.: express' impl of run sets up view reloading
    // and the sets env to process.env.ENV, etc.
    // we are bypassing all of that by using http directly
    http.Server.prototype.listen.call(app, port, null, cb);

    return app;

}

function fromConfiguration (config) {
    // server not already running

    var cb = config.callback;
    cb = cb || null;

    var app = serveExpress(config.port, config.path, cb);

    var baseUrl = "http://" + config.host + ":" + config.port;

    var urls = visitor.composeURLs(
        baseUrl,
        "project" + config.path,
        config.files
    );

    if (urls.length) return visitor.visit(
        config.browsers,
        urls
    );

    ui.log("Visit " + ui.color.bold(baseUrl) + " to run tests.");

    if (config.forceVisit) {
        ui.log("Running tests locally with: " + config.browsers.join(", "));

        return visitor.visit(
            config.browsers,
            [baseUrl]
        );
    }

    return app;
}

exports.getCachebuster = function () {
    return cachebuster;
};

exports.tests = tests;
exports.fromConfiguration = fromConfiguration;
exports.serve = serveExpress;
