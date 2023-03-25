import { DP_EVENTS, DocumentType } from '@dts/common/documents'
import { CodeFileDescriptor, MDFileDescriptor } from '@dts/common/fsal'
import { Update } from '@codemirror/collab'
import { Text } from '@codemirror/state'

/**
 * Holds all information associated with a document that is currently loaded
 */
interface Document {
  /**
   * The absolute path to the file
   */
  filePath: string
  /**
   * The descriptor for the file
   */
  descriptor: MDFileDescriptor|CodeFileDescriptor
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

export class DocumentAuthoritySingleton {
  private static instance: DocumentAuthoritySingleton
  private readonly MAX_VERSION_HISTORY = 100 // Keep no more than this many updates.
  private readonly DELAYED_SAVE_TIMEOUT = 5000 // Delayed timeout means: Save after 5 seconds
  private readonly IMMEDIATE_SAVE_TIMEOUT = 250 // Even "immediate" should not save immediate to save disk space

  /**
   * This holds all currently opened documents somewhere across the app.
   *
   * @var {Document[]}
   */
  private readonly documents: Document[] = []

  private constructor () {}

  public static getInstance (): DocumentAuthoritySingleton {
    if (DocumentAuthoritySingleton.instance === undefined) {
      DocumentAuthoritySingleton.instance = new DocumentAuthoritySingleton()
    }
    return DocumentAuthoritySingleton.instance
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

    let type = DocumentType.Markdown

    const descriptor = await this._app.fsal.getDescriptorForAnySupportedFile(filePath)
    if (descriptor === undefined || descriptor.type === 'other') {
      throw new Error(`Cannot load file ${filePath}`) // TODO: Proper error handling & state recovery!
    }

    const content = await this._app.fsal.loadAnySupportedFile(filePath)

    if (descriptor.type === 'code') {
      switch (descriptor.ext) {
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
    }

    const doc: Document = {
      filePath,
      type,
      descriptor,
      currentVersion: 0,
      minimumVersion: 0,
      lastSavedVersion: 0,
      updates: [],
      document: Text.of(content.split(descriptor.linefeed)),
      lastSavedWordCount: countWords(content, false),
      lastSavedCharCount: countWords(content, true),
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
