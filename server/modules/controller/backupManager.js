const backupCons = require('modules/constants/backup');
const log = require('modules/utility/logger');
const config = require('modules/config');
const MongoDB = require('modules/controller/mongoDB');
const object = require('modules/utility/object');
const backupUtil = require('modules/utility/backup');


class BackupManager {

    constructor(localDB, backupConfig, serverSocket) {
        this.backupDB = object.selfish(new MongoDB(backupConfig));
        this.localDB = localDB;
        this.serverSocket = serverSocket;
        this.backupConfig = backupConfig;
        this.currentBackupCollections = null;
        this.activites = new Set();
        this.start();
    }

    get backupStatus() {
        return this.backupConfig.status;
    }

    get nextBackUpTime() {
        return this.backupConfig.nextBackUpTime;
    }

    start() {
        try {
            if (!this.checkBackupAvailable()) {
                return;
            }

            this.addLog(`Started ${ this.backupConfig.id }`);
            const startTime = backupUtil.getStartTime(this.backupConfig);
            // no start time, backup start now
            const nextBackUpTime = startTime? startTime.toLocaleString(): null;

            this.updateBackupConfigToDB( {startTime,
                                          nextBackUpTime,
                                          status: backupCons.status.WAITING});

            const interval = this.backupConfig.interval;
            const firstTimeout = startTime?(startTime - new Date()): 0;

            let firstBackup = () => {
                this.backup();

                if (interval) {
                    let backUpRoutine = () => {
                        if(this.backupStatus == backupCons.status.RUNNING) {
                            return;
                        }
                        const now = new Date();
                        const nextBackUpTime = new Date(now.valueOf() + interval).toLocaleString();
                        this.updateBackupConfigToDB({ nextBackUpTime });
                        this.backup.call(this);
                    };
                    const nextBackUpTime = new Date(new Date().valueOf() + interval).toLocaleString();
                    this.updateBackupConfigToDB({ nextBackUpTime });
                    this.activites.add(setInterval(backUpRoutine, interval));
                }else{
                    this.updateBackupConfig({ nextBackupTime: null });
                }

            };

            this.activites.add(setTimeout(firstBackup, firstTimeout));
        }catch(e) {
            console.log(e);
        }
    }

    checkBackupAvailable() {
        if(this.backupStatus == backupCons.status.ABORTED ||
            this.backupStatus == backupCons.status.STOP) {
            return false
        }

        return true;
    }

    stop() {
        if(this.backupStatus == backupCons.status.ABORTED){
            return Promise.reject();
        }

        return this.backupDB.close()
            .then(() => {
                return this.updateBackupStatus(backupCons.status.STOP);
            })
            .then(() => {
                this.stopAllActivities();
                this.addLog(`Stop all the backup activities`);
                this.backupConfig.nextBackUpTime = null;
                this.currentBackupCollections = null;
            })
            .catch(err => {
                this.addLog(`Failed to stop backup for ${ err.message }`, 'error');
                throw err;
            })
    }

    backup() {
        const now = new Date();
        const backupTargetDBName = this.getTargetBackUpDBName(now);
        const previousBackupStatus = this.backupStatus;
        log.debug('Backup copy DB Name is ' + backupTargetDBName);
        return Promise.resolve()
            .then(() => {
                if(previousBackupStatus == backupCons.status.RUNNING) {
                    throw new Error(`Failed to start backup for backup is running`);
                }
                this.addLog(`Start to backup ${ this.backupConfig.db }`);
                return this.backupDB.connect()
            })
            .then(() => {
                this.updateBackupStatus(backupCons.status.RUNNING);
                return this.getBackupCollections();
            })
            .then(backupCollections => {
                log.info(`Successfully get backup collections ${ backupCollections }`);
                this.currentBackupCollections = backupCollections;
                return this.backupDB.readFromCollections(this.backupConfig.db, backupCollections)
            })
            .then(collectionsDocs => {
                this.backupDB.close()
                    .then(() => log.info(`Closed ${ this.backupDB.url }`))
                    .catch(err => log.error(`Failed to close ${ this.backupDB.url } for ${ err.message }`));
                return this.localDB.writeToCollections(backupTargetDBName, collectionsDocs)
            })
            .then(() => {
                return this.backupOnWriteSuccess(backupTargetDBName)
            })
            .catch(err => {
                this.backupOnFailure(err, backupTargetDBName);
                throw err;
            })
            .finally(() => {
                let nextStatus = previousBackupStatus;

                if(previousBackupStatus == backupCons.status.WAITING && !this.backupConfig.interval) {
                    nextStatus = backupCons.status.PENDING;
                }

                this.updateBackupStatus(nextStatus);
            });
    }

    stopAllActivities() {
        this.activites.forEach(activity => clearTimeout(activity));
        this.activites.clear();
    }

    backupOnWriteSuccess(backupCopyDBName) {
        const now = new Date();
        const dbDuration = this.backupConfig.duration;
        const deleteTime = dbDuration ? new Date(now.valueOf() + dbDuration) : '';

        return this.addBackupCopyDB(backupCopyDBName, now, deleteTime)
            .then(() => {
                this.addLog(`Backup ${ this.backupConfig.db } to ${ backupCopyDBName } successfully`);
                const updates = {
                    lastBackupTime: this.backupConfig.nextBackUpTime,
                    lastBackupStatus: backupCons.result.SUCCEED,
                    backupTotal: ++this.backupConfig.backupTotal,
                    successfulBackups: ++this.backupConfig.successfulBackups
                };
                this.updateBackupConfigToDB(updates);

                if( dbDuration ) {
                    const deleteDBTask = () => {
                        this.deleteCopyDB(backupCopyDBName);
                    };
                    this.activites.add(setTimeout(deleteDBTask, dbDuration));
                    log.debug(`${ backupCopyDBName } will be deleted at ${ deleteTime.toLocaleString() }`);
                }
                this.deleteExtraCopyDBs();
            })
            .catch(err => {
                throw err;
            });
    }

    backupOnFailure(err, backupCopyDBName) {
        const updates = {
            lastBackupTime: this.backupConfig.nextBackupTime,
            lastBackupStatus: backupCons.result.FAILED,
            backupTotal: ++this.backupConfig.backupTotal,
            failedBackups: ++this.backupConfig.failedBackups
        };
        this.addLog(`Backup ${ this.backupConfig.db } failed for ${ err.message }`, "error");
        this.updateBackupConfigToDB(updates);
        this.localDB.deleteDatabase(backupCopyDBName)
    }


    getTargetBackUpDBName(date) {
        return `${ this.backupConfig.db }-${ date.valueOf() }`
    }

    getBackupCollections() {
        return new Promise((resolve, reject) => {
            if(this.backupConfig.collections) {
                return resolve(this.backupConfig.collections);
            }

            this.backupDB.getCollectionNamesWithDB(this.backupConfig.db)
                .then(collections => {
                    resolve(collections);
                })
                .catch(err => {
                    reject(err);
                })
        })
    }

    getCollections(dbName) {
        if(dbName != this.backupConfig.db) {
            return this.localDB.getCollectionNamesWithDB(dbName)
                .then(collections => {
                    return {db: dbName, collections};
                })
        }

        return this.backupDB.connect()
            .then(() => {
                return this.backupDB.getCollectionNamesWithDB(this.backupConfig.db);
            })
            .then(collections => {
                return {db: dbName, collections};
            })
            .finally(() => {
                this.backupDB.close();
            })
    }

    getDataFromCollection(dbName, collectionName, filter) {
        if(dbName != this.backupConfig.db) {
            return this.localDB.readFromCollection(dbName, collectionName, filter)
        }

        return this.backupDB.connect()
            .then(() => {
                return this.backupDB.readFromCollection(dbName, collectionName, filter);
            })
            .finally(() => {
                this.backupDB.close();
            })
    }

    addLog(content, level="info") {
        const newLog = {
            id: this.backupConfig.id,
            level: level,
            time: new Date().toLocaleString(),
            content: content
        };
        this.localDB.addLog(newLog)
            .then(() => {
                log.debug(`Added log ${ this.backupConfig.id }`);
            })
            .catch(err => {
                log.error(`Failed to add log for ${ this.backupConfig.id } for ${ err.message }`);
                throw err;
            });
    }

    updateBackupConfig(updates) {
        // when update the backupConfig first
        // need to stop all the current activities
        return Promise.resolve()
            .then(() => {
                return this.stop();
            })
            .then(() => {
                return this.updateBackupConfigToDB(updates)
            })
            .then(() => {
                this.addLog(`Updated backup config with ${ JSON.stringify(this.backupConfig) }`)
                this.backupDB.setConnectionParams(this.backupConfig);
                this.updateBackupStatus(backupCons.status.PENDING);
                this.start();
            })
            .catch(err => {
                this.addLog(`Failed to update backup config for ${ this.backupConfig.id } for ${ err.message }`, 'error');
                throw err;
            });
    }

    updateBackupStatus(status) {
        this.addLog(`Backup status changed from ${ this.backupStatus } to ${ status }`);
        return this.updateBackupConfigToDB({ status });
    }

    updateBackupConfigToDB(updates) {
        Object.assign(this.backupConfig, updates);
        this.serverSocket.emit('backupConfigs');
        return this.localDB.updateBackupConfig(this.backupConfig);
    }

    addBackupCopyDB(copyDBName, createdTime, deletedTime) {
        const newBackupCopyDB = {
            id: this.backupConfig.id,
            originalDatabase: {
                server: this.backupConfig.server,
                database: this.backupConfig.db
            },
            name: copyDBName,
                collections: this.currentBackupCollections,
                createdTime: createdTime.toLocaleString(),
                deletedTime: deletedTime.toLocaleString()
        };
        return this.localDB.addCopyDB(newBackupCopyDB);
    }

    deleteCopyDB(dbName) {
        log.info(`Started to delete ${ dbName }`);

        return this.localDB.deleteCopyDBByIDAndName(this.backupConfig.id, dbName)
            .then(() => {
                this.addLog(`deleted ${ dbName } record for ${ this.backupConfig.id } in backup copyDB collections`);
                return this.localDB.deleteDatabase(dbName);
            })
            .then(() => {
                this.addLog(`deleted ${ dbName } completely`)
            })
            .catch(err => {
                this.addLog(`Failed to delete ${ dbName } for ${ err.message }`, "error");
                throw err;
            });
    }

    deleteCollections(dbName, collections) {
        if(dbName != this.backupConfig.db) {
            return this.localDB.deleteCollections(dbName, collections)
                .then(() => {
                    this.addLog(`Deleted ${ collections } of ${ dbName }`);
                })
                .catch(err => {
                    this.addLog(`Failed to delete ${ collections } of ${ dbName } for ${ err.message } `, 'error');
                    throw err;
                })
        }

        return this.backupDB.connect()
            .then(() => {
                return this.backupDB
                    .deleteCollections(this.backupConfig.db, collections)
            })
            .finally(() => {
                this.backupDB.close();
            });
    }

    deleteExtraCopyDBs() {
        return new Promise((resolve, reject) => {
            const { maxBackupNumber } = this.backupConfig;
            console.log(maxBackupNumber);

            if(!maxBackupNumber) {
                return resolve();
            }

            this.localDB.getBackupCopyDatabases(this.backupConfig.id)
                .then(backupCopyDBs => {
                    const copyDBsNumber = backupCopyDBs.length;
                    if(copyDBsNumber <= maxBackupNumber) {
                        return resolve();
                    }
                    log.debug(`Start to deleted ${ copyDBsNumber - maxBackupNumber } extra DBs`);
                    backupCopyDBs = object.sortByTime(backupCopyDBs, "createdTime", true);
                    const extraCopyDBs = backupCopyDBs.slice(maxBackupNumber, copyDBsNumber);
                    return Promise.all(extraCopyDBs.map(copyDB => {
                        return this.deleteCopyDB(copyDB['name']);
                    }))
                })
                .then(() => {
                    resolve();
                })
                .catch(err => {
                    this.addLog(`Failed to deleted extra backup copies for ${ err.message }`, 'error');
                    reject(err);
                })
        })
    }

    deleteOverdueCopyDBs() {
        return Promise.resolve()
            .then(() => {
                return this.localDB.getBackupCopyDatabases(this.backupConfig.id);
            })
            .then(backupCopyDBs => {
                return Promise.all(backupCopyDBs.map(copyDB => {
                    const deletedTime = copyDB['deletedTime'];
                    const dbName = copyDB['name'];
                    if(deletedTime) {
                        const deletedDate = new Date(deletedTime);
                        const now = new Date();
                        if(deletedDate <= now) {
                            this.addLog(`${ dbName } is overdue`);
                            return this.deleteCopyDB(dbName);
                        }else {
                            const deleteDBTask = () => {
                                this.deleteCopyDB(dbName)
                            };
                            this.activites.add(setTimeout(deleteDBTask, deletedDate - now));
                            log.debug(`${ dbName } will be deleted at ${ deletedDate.toLocaleString()}`);
                        }
                    }
                    return Promise.resolve();
                }))
            })
            .catch(err => {
                log.error(`Failed to deleted all the overdue databases for ${ this.backupConfig.id } for ${ err.message }`);
                throw err;
            })
    }
}

module.exports = BackupManager;
