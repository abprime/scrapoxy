'use strict';

var _ = require('lodash'),
    Promise = require('bluebird'),
    InstanceModel = require('../../proxies/manager/instance.model'),
    ovh = require('ovh'),
    winston = require('winston');


module.exports = ProviderOVHCloud;


////////////

function ProviderOVHCloud(config, instancePort) {
    if (!config || !instancePort) {
        throw new Error('[ProviderOVHCloud] should be instanced with config and instancePort');
    }

    this._config = config;
    this._instancePort = instancePort;

    this.name = 'ovhcloud';

    this._flavorId = void 0;
    this._snapshotId = void 0;
    this._sshKeyId = void 0;

    var opts = _.pick(this._config, ['endpoint', 'appKey', 'appSecret', 'consumerKey']);
    this._client = ovh(opts);
}

ProviderOVHCloud.ST_ACTIVE = 'ACTIVE';
ProviderOVHCloud.ST_BUILD = 'BUILD';
ProviderOVHCloud.ST_DELETING = 'DELETING';
ProviderOVHCloud.ST_ERROR = 'ERROR';


ProviderOVHCloud.prototype.getModels = function getModelsFn() {
    var self = this;

    winston.debug('[ProviderOVHCloud] getModels');

    return self._describeInstances()
        .then(summarizeInfo)
        .then(excludeTerminated)
        .then(excludeOutscope)
        .then(convertToModel);

    ////////////

    function summarizeInfo(instancesDesc) {
        return _.map(instancesDesc, function (instanceDesc) {
            return _(instanceDesc)
                .pick(['id', 'status', 'name'])
                .extend({
                    ip: getIP(instanceDesc),
                    toString: function toStringFn() {
                        return '(id=' + this.id + ' / status=' + this.status + ' / ip=' + this.ip + ' / name=' + this.name + ')';
                    },
                })
                .value();
        });

        ////////////

        function getIP(instanceDesc) {
            if (!instanceDesc || !instanceDesc.ipAddresses ||
                instanceDesc.ipAddresses.length <= 0) {
                return;
            }

            return instanceDesc.ipAddresses[0].ip;
        }
    }

    function excludeTerminated(instancesDesc) {
        return _.filter(instancesDesc, function(instanceDesc) {
            return instanceDesc.status !== ProviderOVHCloud.ST_DELETING;
        });
    }

    function excludeOutscope(instancesDesc) {
        return _.filter(instancesDesc, function (instanceDesc) {
            return instanceDesc.name && instanceDesc.name.indexOf(self._config.name) == 0;
        });
    }

    function convertToModel(instancesDesc) {
        return _.map(instancesDesc, function (instanceDesc) {
            return new InstanceModel(
                instanceDesc.id,
                self.name,
                convertStatus(instanceDesc.status),
                buildAddress(instanceDesc.ip),
                instanceDesc
            );
        });


        ////////////

        function buildAddress(ip) {
            if (!ip) {
                return;
            }

            return {
                hostname: ip,
                port: self._instancePort,
            };
        }

        function convertStatus(status) {
            switch (status) {
                case ProviderOVHCloud.ST_ACTIVE:
                {
                    return InstanceModel.STARTED;
                }
                case ProviderOVHCloud.ST_BUILD:
                {
                    return InstanceModel.STARTING;
                }
                case ProviderOVHCloud.ST_ERROR:
                {
                    return InstanceModel.ERROR;
                }
                default:
                {
                    winston.error('[ProviderOVHCloud] Unknown status: ', status);
                    return InstanceModel.ERROR;
                }
            }
        }
    }
};


ProviderOVHCloud.prototype.createInstances = function createInstancesFn(count) {
    var self = this;

    winston.debug('[ProviderOVHCloud] createInstances: count=%d', count);

    return self._describeInstances()
        .then(function (instances) {
            var actualCount = _(instances)
                .filter(function(instance) {
                    return instance.status !== ProviderOVHCloud.ST_DELETING;
                })
                .size();

            winston.debug('[ProviderOVHCloud] createInstances: actualCount=%d', actualCount);

            if (self._config.maxRunningInstances && actualCount + count > self._config.maxRunningInstances) {
                return reject(new Error('[ProviderOVHCloud] createInstances: Cannot start instances (limit reach): ' + actualCount + ' + ' + count + ' > ' + self._config.maxRunningInstances));
            }

            return init()
                .then(function () {
                    var promises = [];

                    for (var i = 0; i < count; ++i) {
                        promises.push(createInstance());
                    }

                    return Promise.all(promises);
                });
        });


    ////////////

    function init() {
        var promises = [];

        // Get flavor id
        if (!self._flavorId) {
            var promise = getFlavorByName(self._config.flavorName)
                .then(function (flavor) {
                    self._flavorId = flavor.id;
                });

            promises.push(promise);
        }

        // Get snapshot id
        if (!self._snapshotId) {
            var promise = getSnapshotByName(self._config.snapshotName)
                .then(function (snapshot) {
                    self._snapshotId = snapshot.id;
                });

            promises.push(promise);
        }

        // Get ssh key id
        if (!self._sshKeyId) {
            var promise = getSSHkeyByName(self._config.sshKeyName)
                .then(function (sshKey) {
                    self._sshKeyId = sshKey.id;
                });

            promises.push(promise);
        }

        return Promise.all(promises);


        ////////////

        function getFlavorByName(name) {
            return new Promise(function (resolve, reject) {
                var options = {
                    serviceName: self._config.serviceId,
                    region: self._config.region,
                };

                self._client.request('GET', '/cloud/project/{serviceName}/flavor', options, function (err, results) {
                    if (err) return reject(err + ': ' + results);

                    var result = _.findWhere(results, {name: name});
                    if (!result) {
                        return reject(new Error("Cannot find flavor by name '" + name + "'"));
                    }

                    resolve(result);
                });
            });
        }

        function getSnapshotByName(name) {
            return new Promise(function (resolve, reject) {
                var options = {
                    serviceName: self._config.serviceId,
                    region: self._config.region,
                };

                self._client.request('GET', '/cloud/project/{serviceName}/snapshot', options, function (err, results) {
                    if (err) return reject(err + ': ' + results);

                    var result = _.findWhere(results, {name: name});
                    if (!result) {
                        return reject(new Error("Cannot find snapshot by name '" + name + "'"));
                    }

                    resolve(result);
                });
            });
        }

        function getSSHkeyByName(name) {
            return new Promise(function (resolve, reject) {
                var options = {
                    serviceName: self._config.serviceId,
                    region: self._config.region,
                };

                self._client.request('GET', '/cloud/project/{serviceName}/sshkey', options, function (err, results) {
                    if (err) return reject(err + ': ' + results);

                    var result = _.findWhere(results, {name: name});
                    if (!result) {
                        return reject(new Error("Cannot find sshKey by name '" + name + "'"));
                    }

                    resolve(result);
                });
            });
        }
    }

    function createInstance() {
        return new Promise(function (resolve, reject) {
            var options = _.assign({
                serviceName: self._config.serviceId,
                region: self._config.region,
                flavorId: self._flavorId,
                imageId: self._snapshotId,
                name: self._config.name,
                sshKeyId: self._sshKeyId,
            });

            self._client.request('POST', '/cloud/project/{serviceName}/instance', options, function (err, results) {
                if (err) return reject(err + ': ' + results);

                resolve();
            });
        });
    }
};


ProviderOVHCloud.prototype.startInstance = function startInstanceFn(model) {
    throw new Error('Unsupported method');
};


ProviderOVHCloud.prototype.deleteInstance = function deleteInstanceFn(model) {
    winston.debug('[ProviderOVHCloud] deleteInstance: model=', model.toString());

    return this._deleteInstance(model.getProviderOpts().id);
};


ProviderOVHCloud.prototype.deleteInstances = function deleteInstancesFn(models) {
    var self = this;

    winston.debug('[ProviderOVHCloud] deleteInstances: models=', _.map(models, function (model) {
        return model.toString();
    }));

    if (models.length <= 0) {
        return;
    }

    return Promise.map(models, function (model) {
        return self._deleteInstance(model.getProviderOpts().id);
    });
};


ProviderOVHCloud.prototype._describeInstances = function _describeInstancesFn() {
    var self = this;

    return new Promise(function (resolve, reject) {
        var options = {
            serviceName: self._config.serviceId,
            region: self._config.region,
        };

        self._client.request('GET', '/cloud/project/{serviceName}/instance', options, function (err, instances) {
            if (err) return reject(err);

            resolve(instances);
        });
    });
};


ProviderOVHCloud.prototype._deleteInstance = function deleteInstanceFn(instanceId) {
    var self = this;

    return new Promise(function (resolve, reject) {
        var options = {
            serviceName: self._config.serviceId,
            instanceId: instanceId,
        };

        self._client.request('DELETE', '/cloud/project/{serviceName}/instance/{instanceId}', options, function (err, results) {
            if (err) return reject(err + ': ' + results);

            resolve(results);
        });
    });
};