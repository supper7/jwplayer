define([
    'api/config',
    'events/events',
    'events/states',
    'utils/backbone.events',
    'utils/helpers',
    'utils/timer',
    'utils/underscore',
    'controller/controller',
    'api/api-actions',
    'api/api-mutators',
    'api/callbacks-deprecate',
    'version'
], function(Config, events, states,
            Events, utils, Timer, _, Controller, actionsInit, mutatorsInit, legacyInit, version) {

    function addFocusBorder(container) {
        utils.addClass(container, 'jw-tab-focus');
    }

    function removeFocusBorder(container) {
        utils.removeClass(container, 'jw-tab-focus');
    }

    var Api = function (container, globalRemovePlayer) {
        var _this = this,
            _controller,
            _playerReady = false,
            _itemMeta = {};

        // Set up event handling
        _.extend(this, Events);

        // This helps plugins, particularly analytics
        this.utils = utils;
        this._ = _;
        this.version = version;

        this.trigger = function(type, args) {
            if (_.isObject(args)) {
                args = _.extend({}, args);
            } else {
                args = {};
            }
            args.type = type;
            return Events.trigger.call(_this, type, args);
        };

        this.on = function(name, callback) {
            if (_.isString(callback)) {
                throw new TypeError('eval callbacks depricated');
            }

            var safeCallback = function() {
                try {
                    callback.apply(this, arguments);
                } catch(e) {
                    utils.log('There was an error calling back an event handler for "'+
                        name+'". Error: '+ e.message);
                }
            };

            return Events.on.call(_this, name, safeCallback);
        };

        // Required by vast
        // <deprecate>
        this.dispatchEvent = this.trigger;
        this.removeEventListener = this.off.bind(this);
        // </deprecate>

        // Add a bunch of methods
        var _resetController = function() {
            if (_controller) {
                _controller.off();
                _controller.reset();
            }
            _controller = new Controller(container);
            actionsInit(_this, _controller);
            mutatorsInit(_this, _controller);
            _controller.on(events.JWPLAYER_PLAYLIST_ITEM, function () {
                _itemMeta = {};
            });
            _controller.on(events.JWPLAYER_MEDIA_META, function (data) {
                _.extend(_itemMeta, data.metadata);
            });
            _controller.on(events.JWPLAYER_VIEW_TAB_FOCUS, function (data) {
                if (data.hasFocus === true) {
                    addFocusBorder(this.getContainer());
                } else {
                    removeFocusBorder(this.getContainer());
                }
            });
            // capture the ready event and add setup time to it
            _controller.on(events.JWPLAYER_READY, function(event) {
                _playerReady = true;
                _qoe.tick('ready');
                event.setupTime = _qoe.between('setup', 'ready');
            });
            _controller.on('all', _this.trigger);
        };
        _resetController();
        legacyInit(this);

        // These should be read-only model properties
        this.id = container.id;

        // Intialize QOE timer
        var _qoe = this._qoe = new Timer();
        _qoe.tick('init');


        var _reset = function() {
            _playerReady = false;
            _itemMeta = {};
            // Reset DOM
            _this.off();
            _resetController();
        };

        var _getPlugin = function(name) {
            // this.plugins is set by plugins.loader `api.plugins = jsplugins.plugins`
            var plugins = _this.plugins;
            return plugins && plugins[name];
        };

        this.setup = function (options) {
            _qoe.tick('setup');

            _reset();

            // bind event listeners passed in to the config
            utils.foreach(options.events, function(evt, val) {
                var fn = _this[evt];
                if (typeof fn === 'function') {
                    fn.call(_this, val);
                }
            });

            var config = new Config(options);
            config.id = _this.id;
            _controller.setup(config, this);

            return _this;
        };

        this.qoe = function() {
            var qoeItem = _controller.getItemQoe();

            var setupTime = _qoe.between('setup', 'ready');
            var firstFrame = qoeItem.between(events.JWPLAYER_MEDIA_PLAY_ATTEMPT, events.JWPLAYER_MEDIA_FIRST_FRAME);

            return {
                setupTime : setupTime,
                firstFrame : firstFrame,
                player : _qoe.dump(),
                item : qoeItem.dump()
            };
        };

        // Request this from the view/controller
        this.getContainer = function () {
            if(_controller.getContainer) {
                // If the controller has fully set up...
                return _controller.getContainer();
            } else {
                // If the controller hasn't set up yet, and we need this (due a setup to error), send the container
                return container;
            }
        };

        this.getMeta = this.getItemMeta = function () {
            return _itemMeta;
        };

        this.getPlaylistItem = function (item) {
            if (!utils.exists(item)) {
                item = _this.getPlaylistIndex();
            }
            return _this.getPlaylist()[item];
        };

        this.getRenderingMode = function () {
            return 'html5';
        };

        this.load = function (toLoad) {
            var plugin = _getPlugin('vast') || _getPlugin('googima');
            if (plugin) {
                plugin.destroy();
            }
            _controller.load(toLoad);
            return _this;
        };

        this.play = function (state) {
            if (state !== undefined) {
                _controller.play(state);
                return _this;
            }

            state = _this.getState();

            var instreamAdapter = _controller._instreamAdapter;
            var instreamState = instreamAdapter && instreamAdapter.getState();
            if (instreamState) {
                switch (instreamState) {
                    case states.IDLE:
                    case states.PLAYING:
                    case states.BUFFERING:
                        instreamAdapter.pause();
                        break;
                    default:
                        instreamAdapter.play();
                }
                return _this;
            }

            switch (state) {
                case states.PLAYING:
                case states.BUFFERING:
                    _controller.pause();
                    break;
                default:
                    _controller.play();
            }

            return _this;
        };

        this.pause = function (state) {
            if (state === undefined) {
                state = _this.getState();
                switch (state) {
                    case states.PLAYING:
                    case states.BUFFERING:
                        _controller.pause();
                        break;
                    default:
                        _controller.play();
                }
            } else {
                _controller.pause(state);
            }
            return _this;
        };

        this.createInstream = function () {
            return _controller.createInstream();
        };

        // These may be overridden by ad plugins
        this.playAd = this.pauseAd = _.noop;

        this.remove = function () {
            // Remove from array of players. this calls this.destroyPlayer()
            globalRemovePlayer(_this);

            // so players can be removed before loading completes
            if (_controller.playerDestroy) {
                _controller.playerDestroy();
            }

            // terminate state
            _this.trigger('remove');
            _reset();
            return _this;
        };

        return this;
    };

    return Api;
});
