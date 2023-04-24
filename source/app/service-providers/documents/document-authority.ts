import { DP_EVENTS, DocumentType } from '@dts/common/documents'
import { Update } from '@codemirror/collab'
import { Text } from '@codemirror/state'
// import { promises as fs } from 'fs'
import type FSAL from '@providers/fsal'
import path from 'path'
import { hasCodeExt, hasMarkdownExt } from '@providers/fsal/util/is-md-or-code-file'
import { countChars, countWords } from '@common/util/counter'
import { markdownToAST } from '@common/modules/markdown-utils'
import chokidar from 'chokidar'
import { EventEmitter } from 'events'
import { promises as fs } from 'fs'
import { type MessageBoxOptions, dialog } from 'electron'
import { trans } from '@common/i18n-main'

async function getModtimeFor (filePath: string): Promise<number> {
  const stat = await fs.lstat(filePath)
  return stat.mtime.getTime()
}

async function replaceFile (filename: string, alwaysReloadFilesChecked: boolean): Promise<boolean> {
  const options: MessageBoxOptions = {
    type: 'question',
    title: trans('Replace file'),
    message: trans('File %s has been modified remotely. Replace the loaded version with the newer one from disk?', filename),
    checkboxLabel: trans('Always load remote changes to the current file'),
    checkboxChecked: alwaysReloadFilesChecked,
    buttons: [
      trans('Cancel'),
      trans('Ok')
    ],
    cancelId: 0,
    defaultId: 1
  }

  const response = await dialog.showMessageBox(options)

  // TODO: config.set('alwaysReloadFiles', response.checkboxChecked)

  return response.response === 1
}

/**
 * Holds all information associated with a document that is currently loaded
 */
interface Document {
  /**
   * The absolute path to the file
   */
  filePath: string
  /**
   * The file type (e.g. Markdown, JSON, YAML)
   */
  type: DocumentType
  /**
   * The current version of the document in memory
   */
  currentVersion: number
  /**
   * The last version for which full updates are available. Editors with a
   * version less than minimumVersion will need to reload the document.
   */
  minimumVersion: number
  /**
   * The last version number that has been saved to disk. If lastSavedVersion
   * === currentVersion, the file is not modified.
   */
  lastSavedVersion: number
  /**
   * Saves the mod time for the file on disk
   */
  modtime: number
  /**
   * Holds all updates between minimumVersion and currentVersion in a granular
   * form.
   */
  updates: Update[]
  /**
   * The actual document text in a CodeMirror format.
   */
  document: Text
  /**
   * Necessary for the word count statistics: The amount of words when the file
   * was last saved to disk.
   */
  lastSavedWordCount: number
  /**
   * Necessary for the word count statistics: The amount of characters when the
   * file was last saved to disk.
   */
  lastSavedCharCount: number
  /**
   * Holds an optional save timeout. This is for when users have indicated they
   * want autosaving.
   */
  saveTimeout: undefined|NodeJS.Timeout
}

export class DocumentAuthoritySingleton extends EventEmitter {
  private static instance: DocumentAuthoritySingleton
  private readonly MAX_VERSION_HISTORY = 100 // Keep no more than this many updates.
  private readonly DELAYED_SAVE_TIMEOUT = 5000 // Delayed timeout means: Save after 5 seconds
  private readonly IMMEDIATE_SAVE_TIMEOUT = 500 // Immediate = half a second
  private readonly watcher: chokidar.FSWatcher
  private readonly ignoreChanges: string[] = []
  private alwaysReloadFiles = false
  private readonly remoteChangeDialogShownFor: string[] = []

  /**
   * This holds all currently opened documents somewhere across the app.
   *
   * @var {Document[]}
   */
  private readonly documents: Document[] = []

  private constructor (private readonly fsal: FSAL) {
    super()
    const options: chokidar.WatchOptions = {
      persistent: true,
      ignoreInitial: true, // Do not track the initial watch as changes
      followSymlinks: true, // Follow symlinks
      ignorePermissionErrors: true, // In the worst case one has to reboot the software, but so it looks nicer.
      // See the description for the next vars in the fsal-watchdog.ts
      interval: 5000,
      binaryInterval: 5000
    }

    // Start up the chokidar process
    this.watcher = new chokidar.FSWatcher(options)

    this.watcher.on('all', (event: string, filePath: string) => {
      if (this.ignoreChanges.includes(filePath)) {
        this.ignoreChanges.splice(this.ignoreChanges.indexOf(filePath), 1)
        return
      }

      if (event === 'unlink') {
        // Close the file everywhere
        this.onUnlinkFile(filePath)
      } else if (event === 'change') {
        this.onChangeFile(filePath)
      }
    })
  }

  public async shutdown (): Promise<void> {
    // TODO: Check if modified files, ask for saving
  }

  public static getInstance (fsal: FSAL): DocumentAuthoritySingleton {
    if (DocumentAuthoritySingleton.instance === undefined) {
      DocumentAuthoritySingleton.instance = new DocumentAuthoritySingleton(fsal)
    }
    return DocumentAuthoritySingleton.instance
  }

  public setAlwaysReloadFiles (alwaysReload: boolean): void {
    this.alwaysReloadFiles = alwaysReload
  }

  private onUnlinkFile (filePath: string): void {
    this.emit('onBeforeUnlinkFile', filePath)
    const idx = this.documents.findIndex(doc => doc.filePath === filePath)
    if (idx > -1) {
      this.documents.splice(idx, 1)
    }

    this.syncWatchedFilePaths()
  }

  private async onChangeFile (filePath: string): Promise<void> {
    const doc = this.documents.find(doc => doc.filePath === filePath)

    if (doc === undefined) {
      throw new Error(`Could not handle remote change for file ${filePath}: Could not find corresponding file!`)
    }

    const modtime = await getModtimeFor(filePath)
    const ourModtime = doc.modtime
    // In response to issue #1621: We will not check for equal modtime but only
    // for newer modtime to prevent sluggish cloud synchronization services
    // (e.g. OneDrive and Box) from having text appear to "jump" from time to time.
    if (modtime > ourModtime) {
      // Notify the caller, that the file has actually changed on disk.
      // The contents of one of the open files have changed.
      // What follows looks a bit ugly, welcome to callback hell.
      if (this.alwaysReloadFiles) {
        await this.notifyRemoteChange(filePath)
      } else {
        // Prevent multiple instances of the dialog, just ask once. The logic
        // always retrieves the most recent version either way
        if (this.remoteChangeDialogShownFor.includes(filePath)) {
          return
        }
        this.remoteChangeDialogShownFor.push(filePath)

        // Ask the user if we should replace the file
        const shouldReplace = await replaceFile(path.basename(filePath), this.alwaysReloadFiles)
        // In any case remove the isShownFor for this file.
        this.remoteChangeDialogShownFor.splice(this.remoteChangeDialogShownFor.indexOf(filePath), 1)
        if (!shouldReplace) {
          this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, { filePath, status: 'modification' })
          return
        }

        await this.notifyRemoteChange(filePath)
      }
    }
  }

  public async getDocument (filePath: string): Promise<{ content: string, type: DocumentType, startVersion: number }> {
    const existingDocument = this.documents.find(doc => doc.filePath === filePath)
    if (existingDocument !== undefined) {
      return {
        content: existingDocument.document.toString(),
        type: existingDocument.type,
        startVersion: existingDocument.currentVersion
      }
    }

    let type: DocumentType | undefined

    const content = await this.fsal.loadAnySupportedFile(filePath)

    if (hasCodeExt(filePath)) {
      switch (path.extname(filePath)) {
        case '.yaml':
        case '.yml':
          type = DocumentType.YAML
          break
        case '.json':
          type = DocumentType.JSON
          break
        case '.tex':
        case '.latex':
          type = DocumentType.LaTeX
      }
    } else if (hasMarkdownExt(filePath)) {
      type = DocumentType.Markdown
    }

    if (type === undefined) {
      throw new Error(`Could not load document ${filePath}: Unknown document type.`)
    }

    const ast = markdownToAST(content)

    const doc: Document = {
      filePath,
      type,
      currentVersion: 0,
      minimumVersion: 0,
      lastSavedVersion: 0,
      updates: [],
      document: Text.of(content.split(/\r\n|\n\r|\n/g)),
      lastSavedWordCount: countWords(ast),
      lastSavedCharCount: countChars(ast),
      modtime: await getModtimeFor(filePath),
      saveTimeout: undefined
    }

    this.documents.push(doc)
    this.syncWatchedFilePaths()

    return { content, type, startVersion: 0 }
  }

  public async pullUpdates (filePath: string, clientVersion: number): Promise<Update[]|false> {
    const doc = this.documents.find(doc => doc.filePath === filePath)
    if (doc === undefined) {
      // Indicate to the editor that they should get the document (again). This
      // handles the case where the document has been remotely modified and thus
      // removed from the document array.
      return false
    }

    if (clientVersion < doc.minimumVersion) {
      // TODO: This means that the client is completely out of sync and needs to
      // re-fetch the whole document.
      return false
    } else if (clientVersion < doc.currentVersion) {
      return doc.updates.slice(clientVersion - doc.minimumVersion)
    } else {
      return [] // No updates available
    }
  }

  public async pushUpdates (filePath: string, clientVersion: number, clientUpdates: any[]): Promise<boolean> { // clientUpdates must be produced via "toJSON"
    const doc = this.documents.find(doc => doc.filePath === filePath)
    if (doc === undefined) {
      throw new Error(`Could not receive updates for file ${filePath}: Not found.`)
    }

    if (clientVersion !== doc.currentVersion) {
      return false
    }

    for (const update of clientUpdates) {
      const changes = ChangeSet.fromJSON(update.changes)
      doc.updates.push(update)
      doc.document = changes.apply(doc.document)
      doc.currentVersion = doc.minimumVersion + doc.updates.length
      // People are lazy, and hence there is a non-zero chance that in a few
      // instances the currentVersion will get dangerously close to
      // Number.MAX_SAFE_INTEGER. In that case, we need to perform a rollback to
      // version 0 and notify all editors that have the document in question
      // open to simply re-load it. That will cause a screen-flicker, but
      // honestly better like this than otherwise.
      if (doc.currentVersion === Number.MAX_SAFE_INTEGER - 1) {
        console.warn(`Document ${filePath} has reached MAX_SAFE_INTEGER. Performing rollback ...`)
        doc.minimumVersion = 0
        doc.currentVersion = doc.updates.length
        // TODO: Broadcast a message so that all editor instances can reload the
        // document.
      }
    }

    // Notify all clients, they will then request the update
    this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, { filePath, status: 'modification' })

    // Drop all updates that exceed the amount of updates we allow.
    while (doc.updates.length > this.MAX_VERSION_HISTORY) {
      doc.updates.shift()
      doc.minimumVersion++
    }

    clearTimeout(doc.saveTimeout)
    const autoSave = this._app.config.get().editor.autoSave

    // No autosave
    if (autoSave === 'off') {
      return true
    }

    const timeout = autoSave === 'delayed' ? this.DELAYED_SAVE_TIMEOUT : this.IMMEDIATE_SAVE_TIMEOUT

    doc.saveTimeout = setTimeout(() => {
      this.saveFile(doc.filePath)
        .catch(err => this._app.log.error(`[Document Provider] Could not save file ${doc.filePath}: ${err.message as string}`, err))
    }, timeout)

    return true
  }

  /**
   * This function ensures that our watcher keeps watching the correct files
   */
  private syncWatchedFilePaths (): void {
    // First, get the files currently watched
    const watchedFiles: string[] = []
    const watched = this.watcher.getWatched()
    for (const dir in watched) {
      for (const filename of watched[dir]) {
        watchedFiles.push(path.join(dir, filename))
      }
    }

    // Second, all documents currently loaded
    const openFiles = this.documents.map(doc => doc.filePath)

    // Third, remove those watched files which are no longer open
    for (const watchedFile of watchedFiles) {
      if (!openFiles.includes(watchedFile)) {
        this.watcher.unwatch(watchedFile)
      }
    }

    // Fourth, add those open files not yet watched
    for (const openFile of openFiles) {
      if (!watchedFiles.includes(openFile)) {
        this.watcher.add(openFile)
      }
    }
  }

  // MODIFICATION
  public isModified (filePath: string): boolean {
    const doc = this.documents.find(doc => doc.filePath === filePath)
    if (doc !== undefined) {
      return doc.currentVersion !== doc.lastSavedVersion
    } else {
      return false // None existing files aren't modified
    }
  }

  public getModifiedDocumentPaths (): string[] {
    return this.documents.filter(x => this.isModified(x.filePath)).map(x => x.filePath)
  }

  // MARK AS CLEAN (OMIT CHANGES)
  public omitChanges (filePath: string): void {
    // TODO
  }

  public omitAllChanges (): void {
    for (const document of this.documents) {
      document.lastSavedVersion = document.currentVersion
    }
  }

  // SAVE DOCUMENTS
  public async saveChanges (filePath: string): Promise<void> {
    // TODO
  }

  public async saveAllChanges (): Promise<void> {
    for (const document of this.documents) {
      await this.saveChanges(document.filePath)
    }
  }
}
