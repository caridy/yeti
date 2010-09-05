function $yetify (config) {

    var w = window,
        YTest = w.YUITest,
        matches;

    if (!$yetify.config) { // first run

        var path = w.location.pathname;

        if (!path) return; // very required

        if (!config) return;
        $yetify.config = config;

        matches = path.match(/^\/project\/([^\/]*)/);
        if (!matches) return;

        $yetify.config.id = matches.pop();

        // prevent careless errors
        w.print = w.confirm = w.alert = w.open = function () {};

    }

    // poll for Y.Test
    if (!YTest) return w.setTimeout($yetify, 50);

    var href = w.location.href,
        YETI = null;

    // YETI reference might not be available for remote tests
    try {
        YETI = parent.YETI;
    } catch (e) {};

    YUI().use("test", function (Y) {

        function submit (data) {

            var self = $yetify.config;

            if (!self.url) return;

            var reporter = new Y.Test.Reporter(
                self.url,
                Y.Test.Format.JSON
            );
            reporter.addField("id", self.id);
            reporter.report(data.results);

            // when running a remote tests, parent.YETI is not available, 
            // is better to redirect to a page that will take care of the next step
            var cb = function() {
                if (YETI) {
                    YETI.next();
                } else if ($yetify.config.delegate) {
                    document.location = 'http://'+$yetify.config.delegate+'/tests/next';
                }
            };

            ifr = reporter._iframe;
            if (ifr.attachEvent) {
                ifr.attachEvent("onload", cb);
            } else {
                ifr.onload = cb;
            }

        };

        w.onerror = function (e) {
            submit({
                results : {
                    name : href,
                    total : 1,
                    passed : 0,
                    failed : 1,
                    data : {
                        failed : 1,
                        name : "window.onerror handler (yeti virtual test)",
                        data : {
                            name : "window.onerror should not fire",
                            message : e,
                            result : "fail"
                        }
                    }
                }
            });
            return false;
        };

        var Runner = YTest.TestRunner;
        Runner.on(Runner.COMPLETE_EVENT, submit);

    });

};
