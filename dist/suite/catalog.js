/**
 * Official Synology Office Suite operations, from the published OpenAPI documents
 * (Drive 2, Spreadsheet 3.4.1, MailPlus 1, Calendar 1).
 *
 * Drive, MailPlus and Calendar are DSM Web APIs behind those REST paths: the session
 * cookie this server already holds is what the documents call `id=<sid>`. Spreadsheet
 * is the separate container. Login and logout are omitted; this server owns the session.
 */
export const SUITE_OPS = [
    {
        "id": "drive.Files.convert_office",
        "product": "drive",
        "summary": "Convert to Synology Office",
        "http": "POST",
        "path": "/api/SynologyDrive/default/v2/files/convert-office",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "convert_office",
            "version": 11
        },
        "read": false,
        "required": [
            "files"
        ]
    },
    {
        "id": "drive.Files.copy",
        "product": "drive",
        "summary": "Copy file or folder",
        "http": "POST",
        "path": "/api/SynologyDrive/default/v2/files/copy",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "copy",
            "version": 11
        },
        "read": false,
        "required": [
            "files",
            "to_parent_folder"
        ]
    },
    {
        "id": "drive.Files.get",
        "product": "drive",
        "summary": "Get metadata",
        "http": "GET",
        "path": "/api/SynologyDrive/default/v2/files",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "get",
            "version": 11
        },
        "read": true,
        "required": [
            "path"
        ]
    },
    {
        "id": "drive.Files.create",
        "product": "drive",
        "summary": "Create file or folder",
        "http": "POST",
        "path": "/api/SynologyDrive/default/v2/files",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "create",
            "version": 11
        },
        "read": false,
        "required": [
            "type",
            "path"
        ]
    },
    {
        "id": "drive.Files.update",
        "product": "drive",
        "summary": "Update metadata",
        "http": "PUT",
        "path": "/api/SynologyDrive/default/v2/files",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "update",
            "version": 11
        },
        "read": false,
        "required": [
            "path"
        ]
    },
    {
        "id": "drive.Files.delete",
        "product": "drive",
        "summary": "Delete file or folder",
        "http": "POST",
        "path": "/api/SynologyDrive/default/v2/files/delete",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "delete",
            "version": 11
        },
        "read": false,
        "required": [
            "files"
        ]
    },
    {
        "id": "drive.Files.download",
        "product": "drive",
        "summary": "Download file or folder",
        "http": "POST",
        "path": "/api/SynologyDrive/default/v2/files/download",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "download",
            "version": 11
        },
        "read": true,
        "binary": true
    },
    {
        "id": "drive.Files.list",
        "product": "drive",
        "summary": "Get files and folders",
        "http": "POST",
        "path": "/api/SynologyDrive/default/v2/files/list",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "list",
            "version": 11
        },
        "read": true,
        "required": [
            "path"
        ]
    },
    {
        "id": "drive.Files.label",
        "product": "drive",
        "summary": "Labels",
        "http": "POST",
        "path": "/api/SynologyDrive/default/v2/files/label",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "label",
            "version": 11
        },
        "read": false,
        "required": [
            "labels",
            "files"
        ]
    },
    {
        "id": "drive.Files.list_starred",
        "product": "drive",
        "summary": "List items marked with a star",
        "http": "GET",
        "path": "/api/SynologyDrive/default/v2/files/starred",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "list_starred",
            "version": 11
        },
        "read": true
    },
    {
        "id": "drive.Files.recent",
        "product": "drive",
        "summary": "List items recently used",
        "http": "GET",
        "path": "/api/SynologyDrive/default/v2/files/recent",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "recent",
            "version": 11
        },
        "read": true
    },
    {
        "id": "drive.Files.shared_with_me",
        "product": "drive",
        "summary": "List items shared with signed in user",
        "http": "GET",
        "path": "/api/SynologyDrive/default/v2/files/shared-with-me",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "shared_with_me",
            "version": 11
        },
        "read": true
    },
    {
        "id": "drive.Files.list_labelled",
        "product": "drive",
        "summary": "List items with specified labels",
        "http": "GET",
        "path": "/api/SynologyDrive/default/v2/files/labelled/{label_id}",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "list_labelled",
            "version": 11
        },
        "read": true,
        "required": [
            "label_id"
        ]
    },
    {
        "id": "drive.Files.list_ancestor",
        "product": "drive",
        "summary": "List parent folder",
        "http": "GET",
        "path": "/api/SynologyDrive/default/v2/files/ancestors",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "list_ancestor",
            "version": 11
        },
        "read": true,
        "required": [
            "path"
        ]
    },
    {
        "id": "drive.Files.shared_with_others",
        "product": "drive",
        "summary": "List shared items in my drive or team folders",
        "http": "GET",
        "path": "/api/SynologyDrive/default/v2/files/shared-with-others",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "shared_with_others",
            "version": 11
        },
        "read": true
    },
    {
        "id": "drive.Files.move",
        "product": "drive",
        "summary": "Move",
        "http": "POST",
        "path": "/api/SynologyDrive/default/v2/files/move",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "move",
            "version": 11
        },
        "read": false,
        "required": [
            "to_parent_folder",
            "files"
        ]
    },
    {
        "id": "drive.Files.request_access",
        "product": "drive",
        "summary": "Request permission",
        "http": "POST",
        "path": "/api/SynologyDrive/default/v2/files/request-access",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "request_access",
            "version": 11
        },
        "read": false,
        "required": [
            "path"
        ]
    },
    {
        "id": "drive.Files.search",
        "product": "drive",
        "summary": "Search",
        "http": "POST",
        "path": "/api/SynologyDrive/default/v2/files/search",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "search",
            "version": 11
        },
        "read": true
    },
    {
        "id": "drive.Files.star",
        "product": "drive",
        "summary": "Stars",
        "http": "POST",
        "path": "/api/SynologyDrive/default/v2/files/star",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "star",
            "version": 11
        },
        "read": false,
        "required": [
            "starred",
            "files"
        ]
    },
    {
        "id": "drive.Files.get_thumbnail",
        "product": "drive",
        "summary": "Thumbnails",
        "http": "GET",
        "path": "/api/SynologyDrive/default/v2/files/thumbnail",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "get_thumbnail",
            "version": 11
        },
        "read": true,
        "binary": true,
        "required": [
            "path"
        ]
    },
    {
        "id": "drive.Files.upload",
        "product": "drive",
        "summary": "Upload",
        "http": "PUT",
        "path": "/api/SynologyDrive/default/v2/files/upload",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "upload",
            "version": 11
        },
        "read": false,
        "upload": true
    },
    {
        "id": "drive.Files.upload_from_dsm",
        "product": "drive",
        "summary": "Upload from NAS's shared folders",
        "http": "PUT",
        "path": "/api/SynologyDrive/default/v2/files/upload-from-dsm",
        "syno": {
            "api": "SYNO.SynologyDrive.Files",
            "method": "upload_from_dsm",
            "version": 11
        },
        "read": false,
        "required": [
            "dsm_paths",
            "path"
        ]
    },
    {
        "id": "drive.Sharing.create_link",
        "product": "drive",
        "summary": "Create sharing link",
        "http": "POST",
        "path": "/api/SynologyDrive/default/v2/sharing/create-link",
        "syno": {
            "api": "SYNO.SynologyDrive.Sharing",
            "method": "create_link",
            "version": 2
        },
        "read": false,
        "required": [
            "path"
        ]
    },
    {
        "id": "drive.Sharing.list",
        "product": "drive",
        "summary": "List permissions",
        "http": "GET",
        "path": "/api/SynologyDrive/default/v2/sharing",
        "syno": {
            "api": "SYNO.SynologyDrive.Sharing",
            "method": "list",
            "version": 2
        },
        "read": true,
        "required": [
            "path"
        ]
    },
    {
        "id": "drive.Sharing.update",
        "product": "drive",
        "summary": "Update permissions",
        "http": "PUT",
        "path": "/api/SynologyDrive/default/v2/sharing/permissions",
        "syno": {
            "api": "SYNO.SynologyDrive.Sharing",
            "method": "update",
            "version": 2
        },
        "read": false,
        "required": [
            "permissions",
            "path"
        ]
    },
    {
        "id": "drive.TeamFolders.list",
        "product": "drive",
        "summary": "Get",
        "http": "GET",
        "path": "/api/SynologyDrive/default/v2/team-folder",
        "syno": {
            "api": "SYNO.SynologyDrive.TeamFolders",
            "method": "list",
            "version": 1
        },
        "read": true
    },
    {
        "id": "drive.TeamFolders.list_members",
        "product": "drive",
        "summary": "Get members",
        "http": "GET",
        "path": "/api/SynologyDrive/default/v2/team-folder/members",
        "syno": {
            "api": "SYNO.SynologyDrive.TeamFolders",
            "method": "list_members",
            "version": 1
        },
        "read": true,
        "required": [
            "team_id"
        ]
    },
    {
        "id": "drive.FileRequest.get",
        "product": "drive",
        "summary": "Get",
        "http": "GET",
        "path": "/api/SynologyDrive/default/v2/file-request/{sharing_link_id}",
        "syno": {
            "api": "SYNO.SynologyDrive.FileRequest",
            "method": "get",
            "version": 1
        },
        "read": true,
        "required": [
            "sharing_link"
        ]
    },
    {
        "id": "drive.FileRequest.update",
        "product": "drive",
        "summary": "Update",
        "http": "PUT",
        "path": "/api/SynologyDrive/default/v2/file-request/{sharing_link_id}",
        "syno": {
            "api": "SYNO.SynologyDrive.FileRequest",
            "method": "update",
            "version": 1
        },
        "read": false,
        "required": [
            "path",
            "sharing_link"
        ]
    },
    {
        "id": "drive.FileRequest.delete",
        "product": "drive",
        "summary": "Delete",
        "http": "DELETE",
        "path": "/api/SynologyDrive/default/v2/file-request/{sharing_link_id}",
        "syno": {
            "api": "SYNO.SynologyDrive.FileRequest",
            "method": "delete",
            "version": 1
        },
        "read": false,
        "required": [
            "sharing_link"
        ]
    },
    {
        "id": "drive.FileRequest.list",
        "product": "drive",
        "summary": "List",
        "http": "GET",
        "path": "/api/SynologyDrive/default/v2/file-request",
        "syno": {
            "api": "SYNO.SynologyDrive.FileRequest",
            "method": "list",
            "version": 1
        },
        "read": true
    },
    {
        "id": "drive.FileRequest.create",
        "product": "drive",
        "summary": "Create",
        "http": "POST",
        "path": "/api/SynologyDrive/default/v2/file-request",
        "syno": {
            "api": "SYNO.SynologyDrive.FileRequest",
            "method": "create",
            "version": 1
        },
        "read": false,
        "required": [
            "title",
            "path"
        ]
    },
    {
        "id": "drive.Labels.list",
        "product": "drive",
        "summary": "Get",
        "http": "GET",
        "path": "/api/SynologyDrive/default/v2/labels",
        "syno": {
            "api": "SYNO.SynologyDrive.Labels",
            "method": "list",
            "version": 3
        },
        "read": true
    },
    {
        "id": "drive.Labels.create",
        "product": "drive",
        "summary": "Create",
        "http": "POST",
        "path": "/api/SynologyDrive/default/v2/labels",
        "syno": {
            "api": "SYNO.SynologyDrive.Labels",
            "method": "create",
            "version": 3
        },
        "read": false,
        "required": [
            "name"
        ]
    },
    {
        "id": "drive.Labels.update",
        "product": "drive",
        "summary": "Update",
        "http": "PUT",
        "path": "/api/SynologyDrive/default/v2/labels/{label_id}",
        "syno": {
            "api": "SYNO.SynologyDrive.Labels",
            "method": "update",
            "version": 3
        },
        "read": false,
        "required": [
            "label_id"
        ]
    },
    {
        "id": "drive.Labels.delete",
        "product": "drive",
        "summary": "Delete",
        "http": "DELETE",
        "path": "/api/SynologyDrive/default/v2/labels/{label_id}",
        "syno": {
            "api": "SYNO.SynologyDrive.Labels",
            "method": "delete",
            "version": 3
        },
        "read": false,
        "required": [
            "label_id"
        ]
    },
    {
        "id": "drive.Labels.list_shared",
        "product": "drive",
        "summary": "Get shared label",
        "http": "GET",
        "path": "/api/SynologyDrive/default/v2/labels/shared",
        "syno": {
            "api": "SYNO.SynologyDrive.Labels",
            "method": "list_shared",
            "version": 3
        },
        "read": true
    },
    {
        "id": "drive.Labels.update_shared",
        "product": "drive",
        "summary": "Update shared label",
        "http": "POST",
        "path": "/api/SynologyDrive/default/v2/labels/shared/{label_id}",
        "syno": {
            "api": "SYNO.SynologyDrive.Labels",
            "method": "update_shared",
            "version": 3
        },
        "read": false,
        "required": [
            "label_id"
        ]
    },
    {
        "id": "drive.Share.list_active",
        "product": "drive",
        "summary": "List enabled team folders",
        "http": "GET",
        "path": "/api/SynologyDrive/default/v2/admin/active-team-folder",
        "syno": {
            "api": "SYNO.SynologyDrive.Share",
            "method": "list_active",
            "version": 2
        },
        "read": true
    },
    {
        "id": "drive.Share.set",
        "product": "drive",
        "summary": "Enable, disable, or configure settings for team folders and my drive",
        "http": "POST",
        "path": "/api/SynologyDrive/default/v2/admin/team-folder",
        "syno": {
            "api": "SYNO.SynologyDrive.Share",
            "method": "set",
            "version": 2
        },
        "read": false,
        "required": [
            "share"
        ]
    },
    {
        "id": "drive.Share.list",
        "product": "drive",
        "summary": "List shared folders and settings",
        "http": "GET",
        "path": "/api/SynologyDrive/default/v2/admin/available-team-folder",
        "syno": {
            "api": "SYNO.SynologyDrive.Share",
            "method": "list",
            "version": 2
        },
        "read": true
    },
    {
        "id": "drive.Connection.list",
        "product": "drive",
        "summary": "List connections",
        "http": "GET",
        "path": "/api/SynologyDrive/default/v2/admin/client",
        "syno": {
            "api": "SYNO.SynologyDrive.Connection",
            "method": "list",
            "version": 2
        },
        "read": true
    },
    {
        "id": "drive.Connection.delete",
        "product": "drive",
        "summary": "Unlink with given client",
        "http": "POST",
        "path": "/api/SynologyDrive/default/v2/admin/client",
        "syno": {
            "api": "SYNO.SynologyDrive.Connection",
            "method": "delete",
            "version": 2
        },
        "read": false,
        "required": [
            "client_sess_id"
        ]
    },
    {
        "id": "drive.Webhooks.create",
        "product": "drive",
        "summary": "Create",
        "http": "POST",
        "path": "/api/SynologyDrive/default/v2/webhooks",
        "syno": {
            "api": "SYNO.SynologyDrive.Webhooks",
            "method": "create",
            "version": 2
        },
        "read": false,
        "required": [
            "type",
            "app_id"
        ]
    },
    {
        "id": "drive.Webhooks.get",
        "product": "drive",
        "summary": "Get",
        "http": "GET",
        "path": "/api/SynologyDrive/default/v2/webhooks/{webhook_id}/{app_id}",
        "syno": {
            "api": "SYNO.SynologyDrive.Webhooks",
            "method": "get",
            "version": 2
        },
        "read": true,
        "required": [
            "webhook_id",
            "app_id"
        ]
    },
    {
        "id": "drive.Webhooks.update",
        "product": "drive",
        "summary": "Update",
        "http": "PUT",
        "path": "/api/SynologyDrive/default/v2/webhooks/{webhook_id}/{app_id}",
        "syno": {
            "api": "SYNO.SynologyDrive.Webhooks",
            "method": "update",
            "version": 2
        },
        "read": false,
        "required": [
            "type",
            "webhook_id",
            "app_id"
        ]
    },
    {
        "id": "drive.Webhooks.delete",
        "product": "drive",
        "summary": "Delete",
        "http": "DELETE",
        "path": "/api/SynologyDrive/default/v2/webhooks/{webhook_id}/{app_id}",
        "syno": {
            "api": "SYNO.SynologyDrive.Webhooks",
            "method": "delete",
            "version": 2
        },
        "read": false,
        "required": [
            "webhook_id",
            "app_id"
        ]
    },
    {
        "id": "drive.Webhooks.list",
        "product": "drive",
        "summary": "Get hooks for a signed in user or integrated application",
        "http": "GET",
        "path": "/api/SynologyDrive/default/v2/webhooks/{app_id}",
        "syno": {
            "api": "SYNO.SynologyDrive.Webhooks",
            "method": "list",
            "version": 2
        },
        "read": true,
        "required": [
            "app_id"
        ]
    },
    {
        "id": "mail.Draft.send",
        "product": "mail",
        "summary": "Send email",
        "http": "POST",
        "path": "/api/MailClient/default/v1/drafts/send",
        "syno": {
            "api": "SYNO.MailClient.Draft",
            "method": "send",
            "version": 6
        },
        "read": false
    },
    {
        "id": "mail.Mailbox.get",
        "product": "mail",
        "summary": "Get",
        "http": "GET",
        "path": "/api/MailClient/default/v1/mailboxes",
        "syno": {
            "api": "SYNO.MailClient.Mailbox",
            "method": "get",
            "version": 7
        },
        "read": true,
        "required": [
            "id"
        ]
    },
    {
        "id": "mail.Mailbox.create",
        "product": "mail",
        "summary": "Create",
        "http": "POST",
        "path": "/api/MailClient/default/v1/mailboxes",
        "syno": {
            "api": "SYNO.MailClient.Mailbox",
            "method": "create",
            "version": 7
        },
        "read": false,
        "required": [
            "name"
        ]
    },
    {
        "id": "mail.Mailbox.set",
        "product": "mail",
        "summary": "Set properties",
        "http": "PUT",
        "path": "/api/MailClient/default/v1/mailboxes",
        "syno": {
            "api": "SYNO.MailClient.Mailbox",
            "method": "set",
            "version": 7
        },
        "read": false,
        "required": [
            "id"
        ]
    },
    {
        "id": "mail.Mailbox.delete",
        "product": "mail",
        "summary": "Delete",
        "http": "DELETE",
        "path": "/api/MailClient/default/v1/mailboxes",
        "syno": {
            "api": "SYNO.MailClient.Mailbox",
            "method": "delete",
            "version": 7
        },
        "read": false,
        "required": [
            "id",
            "conversation_view"
        ]
    },
    {
        "id": "mail.Mailbox.list",
        "product": "mail",
        "summary": "List",
        "http": "GET",
        "path": "/api/MailClient/default/v1/mailboxes/list",
        "syno": {
            "api": "SYNO.MailClient.Mailbox",
            "method": "list",
            "version": 7
        },
        "read": true
    },
    {
        "id": "mail.Label.get",
        "product": "mail",
        "summary": "Get",
        "http": "GET",
        "path": "/api/MailClient/default/v1/labels",
        "syno": {
            "api": "SYNO.MailClient.Label",
            "method": "get",
            "version": 3
        },
        "read": true,
        "required": [
            "id"
        ]
    },
    {
        "id": "mail.Label.create",
        "product": "mail",
        "summary": "Create",
        "http": "POST",
        "path": "/api/MailClient/default/v1/labels",
        "syno": {
            "api": "SYNO.MailClient.Label",
            "method": "create",
            "version": 3
        },
        "read": false,
        "required": [
            "name",
            "text_color",
            "background_color"
        ]
    },
    {
        "id": "mail.Label.set",
        "product": "mail",
        "summary": "Set properties",
        "http": "PUT",
        "path": "/api/MailClient/default/v1/labels",
        "syno": {
            "api": "SYNO.MailClient.Label",
            "method": "set",
            "version": 3
        },
        "read": false,
        "required": [
            "id"
        ]
    },
    {
        "id": "mail.Label.delete",
        "product": "mail",
        "summary": "Delete",
        "http": "DELETE",
        "path": "/api/MailClient/default/v1/labels",
        "syno": {
            "api": "SYNO.MailClient.Label",
            "method": "delete",
            "version": 3
        },
        "read": false,
        "required": [
            "id"
        ]
    },
    {
        "id": "mail.Label.list",
        "product": "mail",
        "summary": "List",
        "http": "GET",
        "path": "/api/MailClient/default/v1/labels/list",
        "syno": {
            "api": "SYNO.MailClient.Label",
            "method": "list",
            "version": 3
        },
        "read": true
    },
    {
        "id": "mail.Filter.list",
        "product": "mail",
        "summary": "List",
        "http": "GET",
        "path": "/api/MailClient/default/v1/filters/list",
        "syno": {
            "api": "SYNO.MailClient.Filter",
            "method": "list",
            "version": 3
        },
        "read": true
    },
    {
        "id": "mail.Filter.get",
        "product": "mail",
        "summary": "Get",
        "http": "GET",
        "path": "/api/MailClient/default/v1/filters",
        "syno": {
            "api": "SYNO.MailClient.Filter",
            "method": "get",
            "version": 3
        },
        "read": true,
        "required": [
            "id"
        ]
    },
    {
        "id": "mail.Filter.create",
        "product": "mail",
        "summary": "Create",
        "http": "POST",
        "path": "/api/MailClient/default/v1/filters",
        "syno": {
            "api": "SYNO.MailClient.Filter",
            "method": "create",
            "version": 3
        },
        "read": false,
        "required": [
            "condition",
            "action"
        ]
    },
    {
        "id": "mail.Filter.set",
        "product": "mail",
        "summary": "Set properties",
        "http": "PUT",
        "path": "/api/MailClient/default/v1/filters",
        "syno": {
            "api": "SYNO.MailClient.Filter",
            "method": "set",
            "version": 3
        },
        "read": false,
        "required": [
            "id",
            "condition",
            "action"
        ]
    },
    {
        "id": "mail.Filter.delete",
        "product": "mail",
        "summary": "Delete",
        "http": "DELETE",
        "path": "/api/MailClient/default/v1/filters",
        "syno": {
            "api": "SYNO.MailClient.Filter",
            "method": "delete",
            "version": 3
        },
        "read": false,
        "required": [
            "id"
        ]
    },
    {
        "id": "calendar.Timezone.list",
        "product": "calendar",
        "summary": "List Timezone",
        "http": "GET",
        "path": "/api/Calendar/default/v1/timezone",
        "syno": {
            "api": "SYNO.Cal.Timezone",
            "method": "list",
            "version": 5
        },
        "read": true
    },
    {
        "id": "calendar.Setting.get",
        "product": "calendar",
        "summary": "Obtain relevant user settings",
        "http": "GET",
        "path": "/api/Calendar/default/v1/setting",
        "syno": {
            "api": "SYNO.Cal.Setting",
            "method": "get",
            "version": 5
        },
        "read": true
    },
    {
        "id": "calendar.Setting.set",
        "product": "calendar",
        "summary": "Modify a user's settings",
        "http": "PUT",
        "path": "/api/Calendar/default/v1/setting",
        "syno": {
            "api": "SYNO.Cal.Setting",
            "method": "set",
            "version": 5
        },
        "read": false
    },
    {
        "id": "calendar.Contact.list",
        "product": "calendar",
        "summary": "Get an user contact list",
        "http": "GET",
        "path": "/api/Calendar/default/v1/contact",
        "syno": {
            "api": "SYNO.Cal.Contact",
            "method": "list",
            "version": 1
        },
        "read": true
    },
    {
        "id": "calendar.Event.get",
        "product": "calendar",
        "summary": "Get an event",
        "http": "GET",
        "path": "/api/Calendar/default/v1/event",
        "syno": {
            "api": "SYNO.Cal.Event",
            "method": "get",
            "version": 5
        },
        "read": true
    },
    {
        "id": "calendar.Event.create",
        "product": "calendar",
        "summary": "Create a new event",
        "http": "POST",
        "path": "/api/Calendar/default/v1/event",
        "syno": {
            "api": "SYNO.Cal.Event",
            "method": "create",
            "version": 5
        },
        "read": false,
        "required": [
            "cal_id",
            "original_cal_id",
            "summary",
            "is_all_day",
            "tz_id",
            "dtstart",
            "dtend",
            "is_repeat_evt",
            "color",
            "notify_setting",
            "description",
            "participant"
        ]
    },
    {
        "id": "calendar.Event.set",
        "product": "calendar",
        "summary": "Modify an event",
        "http": "PUT",
        "path": "/api/Calendar/default/v1/event",
        "syno": {
            "api": "SYNO.Cal.Event",
            "method": "set",
            "version": 5
        },
        "read": false,
        "required": [
            "evt_id",
            "cal_id",
            "original_cal_id",
            "dav_etag",
            "summary",
            "is_all_day",
            "tz_id",
            "dtstart",
            "dtend",
            "is_repeat_evt",
            "color",
            "notify_setting",
            "description",
            "participant",
            "location_info",
            "attachments"
        ]
    },
    {
        "id": "calendar.Event.delete",
        "product": "calendar",
        "summary": "Delete an event",
        "http": "DELETE",
        "path": "/api/Calendar/default/v1/event",
        "syno": {
            "api": "SYNO.Cal.Event",
            "method": "delete",
            "version": 5
        },
        "read": false,
        "required": [
            "evt_id"
        ]
    },
    {
        "id": "calendar.Event.subevent_set",
        "product": "calendar",
        "summary": "Modify a sub-event",
        "http": "PUT",
        "path": "/api/Calendar/default/v1/event/subevent",
        "syno": {
            "api": "SYNO.Cal.Event",
            "method": "subevent_set",
            "version": 5
        },
        "read": false,
        "required": [
            "evt_id",
            "recurrence_id",
            "cal_id",
            "original_cal_id",
            "dav_etag",
            "summary",
            "is_all_day",
            "tz_id",
            "dtstart",
            "dtend",
            "color",
            "notify_setting",
            "description",
            "attachments"
        ]
    },
    {
        "id": "calendar.Event.invite_event_set",
        "product": "calendar",
        "summary": "Modify Invited event alert",
        "http": "PUT",
        "path": "/api/Calendar/default/v1/event/invite-event",
        "syno": {
            "api": "SYNO.Cal.Event",
            "method": "invite_event_set",
            "version": 5
        },
        "read": false,
        "required": [
            "evt_id",
            "cal_id",
            "original_cal_id",
            "dav_etag",
            "notify_setting"
        ]
    },
    {
        "id": "calendar.Event.invite_subevent_set",
        "product": "calendar",
        "summary": "Modify Invited sub event alert",
        "http": "PUT",
        "path": "/api/Calendar/default/v1/event/invite-subevent",
        "syno": {
            "api": "SYNO.Cal.Event",
            "method": "invite_subevent_set",
            "version": 5
        },
        "read": false,
        "required": [
            "evt_id",
            "recurrence_id",
            "cal_id",
            "original_cal_id",
            "dav_etag",
            "is_all_day",
            "tz_id",
            "dtstart",
            "dtend",
            "notify_setting",
            "attachments"
        ]
    },
    {
        "id": "calendar.Event.list",
        "product": "calendar",
        "summary": "List events",
        "http": "POST",
        "path": "/api/Calendar/default/v1/event/list",
        "syno": {
            "api": "SYNO.Cal.Event",
            "method": "list",
            "version": 5
        },
        "read": true
    },
    {
        "id": "calendar.Event.set_exdate",
        "product": "calendar",
        "summary": "Set an exclusive date for repeating events",
        "http": "PUT",
        "path": "/api/Calendar/default/v1/event/exdate",
        "syno": {
            "api": "SYNO.Cal.Event",
            "method": "set_exdate",
            "version": 5
        },
        "read": false,
        "required": [
            "evt_id",
            "dav_etag",
            "exdate"
        ]
    },
    {
        "id": "calendar.Event.set_personal_property",
        "product": "calendar",
        "summary": "Set specific properties of an event",
        "http": "PUT",
        "path": "/api/Calendar/default/v1/event/personal-property",
        "syno": {
            "api": "SYNO.Cal.Event",
            "method": "set_personal_property",
            "version": 5
        },
        "read": false,
        "required": [
            "evt_id",
            "is_visible"
        ]
    },
    {
        "id": "calendar.Todo.list",
        "product": "calendar",
        "summary": "List tasks",
        "http": "POST",
        "path": "/api/Calendar/default/v1/task/list",
        "syno": {
            "api": "SYNO.Cal.Todo",
            "method": "list",
            "version": 5
        },
        "read": true
    },
    {
        "id": "calendar.Todo.get",
        "product": "calendar",
        "summary": "Get task",
        "http": "GET",
        "path": "/api/Calendar/default/v1/task",
        "syno": {
            "api": "SYNO.Cal.Todo",
            "method": "get",
            "version": 5
        },
        "read": true,
        "required": [
            "evt_id"
        ]
    },
    {
        "id": "calendar.Todo.create",
        "product": "calendar",
        "summary": "Create task",
        "http": "POST",
        "path": "/api/Calendar/default/v1/task",
        "syno": {
            "api": "SYNO.Cal.Todo",
            "method": "create",
            "version": 5
        },
        "read": false,
        "required": [
            "description",
            "has_end_time",
            "has_start_time",
            "original_cal_id",
            "percent_complete",
            "summary",
            "tzid"
        ]
    },
    {
        "id": "calendar.Todo.set",
        "product": "calendar",
        "summary": "Update task",
        "http": "PUT",
        "path": "/api/Calendar/default/v1/task",
        "syno": {
            "api": "SYNO.Cal.Todo",
            "method": "set",
            "version": 5
        },
        "read": false,
        "required": [
            "description",
            "has_end_time",
            "has_start_time",
            "original_cal_id",
            "percent_complete",
            "summary",
            "tzid",
            "dav_etag",
            "priority_order"
        ]
    },
    {
        "id": "calendar.Todo.delete",
        "product": "calendar",
        "summary": "Delete task",
        "http": "DELETE",
        "path": "/api/Calendar/default/v1/task",
        "syno": {
            "api": "SYNO.Cal.Todo",
            "method": "delete",
            "version": 5
        },
        "read": false,
        "required": [
            "evt_id"
        ]
    },
    {
        "id": "calendar.Cal.get",
        "product": "calendar",
        "summary": "Get a calendar information",
        "http": "GET",
        "path": "/api/Calendar/default/v1/cal",
        "syno": {
            "api": "SYNO.Cal.Cal",
            "method": "get",
            "version": 5
        },
        "read": true,
        "required": [
            "cal_id"
        ]
    },
    {
        "id": "calendar.Cal.create",
        "product": "calendar",
        "summary": "Create a new calendar",
        "http": "POST",
        "path": "/api/Calendar/default/v1/cal",
        "syno": {
            "api": "SYNO.Cal.Cal",
            "method": "create",
            "version": 5
        },
        "read": false,
        "required": [
            "cal_displayname",
            "cal_description",
            "cal_color",
            "is_hidden_in_cal",
            "is_hidden_in_list",
            "notify_alarm_by_browser",
            "notify_alarm_by_mail",
            "notify_evt_by_browser",
            "notify_evt_by_mail",
            "notify_import_cal_by_browser",
            "notify_import_cal_by_mail",
            "cal_type"
        ]
    },
    {
        "id": "calendar.Cal.set",
        "product": "calendar",
        "summary": "Modify a calendar",
        "http": "PUT",
        "path": "/api/Calendar/default/v1/cal",
        "syno": {
            "api": "SYNO.Cal.Cal",
            "method": "set",
            "version": 5
        },
        "read": false,
        "required": [
            "cal_displayname",
            "cal_description",
            "cal_color",
            "is_hidden_in_cal",
            "is_hidden_in_list",
            "notify_alarm_by_browser",
            "notify_alarm_by_mail",
            "notify_evt_by_browser",
            "notify_evt_by_mail",
            "notify_import_cal_by_browser",
            "notify_import_cal_by_mail",
            "cal_id",
            "original_cal_id"
        ]
    },
    {
        "id": "calendar.Cal.delete",
        "product": "calendar",
        "summary": "Delete a calendar",
        "http": "DELETE",
        "path": "/api/Calendar/default/v1/cal",
        "syno": {
            "api": "SYNO.Cal.Cal",
            "method": "delete",
            "version": 5
        },
        "read": false,
        "required": [
            "cal_id"
        ]
    },
    {
        "id": "calendar.Cal.list",
        "product": "calendar",
        "summary": "Get a calendar list",
        "http": "GET",
        "path": "/api/Calendar/default/v1/cal/list",
        "syno": {
            "api": "SYNO.Cal.Cal",
            "method": "list",
            "version": 5
        },
        "read": true,
        "required": [
            "cal_type"
        ]
    },
    {
        "id": "calendar.Cal.export",
        "product": "calendar",
        "summary": "Export ics",
        "http": "GET",
        "path": "/api/Calendar/default/v1/cal/export",
        "syno": {
            "api": "SYNO.Cal.Cal",
            "method": "export",
            "version": 1
        },
        "read": true,
        "binary": true,
        "required": [
            "cal_id"
        ]
    },
    {
        "id": "spreadsheet.get.spreadsheets.values",
        "product": "spreadsheet",
        "summary": "Get",
        "http": "GET",
        "path": "/spreadsheets/{spreadsheetId}/values/{range}",
        "read": true
    },
    {
        "id": "spreadsheet.put.spreadsheets.values",
        "product": "spreadsheet",
        "summary": "Write",
        "http": "PUT",
        "path": "/spreadsheets/{spreadsheetId}/values/{range}",
        "read": false
    },
    {
        "id": "spreadsheet.put.spreadsheets.values.append",
        "product": "spreadsheet",
        "summary": "Append",
        "http": "PUT",
        "path": "/spreadsheets/{spreadsheetId}/values/{range}/append",
        "read": false
    },
    {
        "id": "spreadsheet.get.spreadsheets.styles",
        "product": "spreadsheet",
        "summary": "Get",
        "http": "GET",
        "path": "/spreadsheets/{spreadsheetId}/styles/{range}",
        "read": true
    },
    {
        "id": "spreadsheet.put.spreadsheets.styles",
        "product": "spreadsheet",
        "summary": "Write",
        "http": "PUT",
        "path": "/spreadsheets/{spreadsheetId}/styles",
        "read": false
    },
    {
        "id": "spreadsheet.post.spreadsheets.sheet.add",
        "product": "spreadsheet",
        "summary": "Create",
        "http": "POST",
        "path": "/spreadsheets/{spreadsheetId}/sheet/add",
        "read": false
    },
    {
        "id": "spreadsheet.get.spreadsheets.sheet.csv",
        "product": "spreadsheet",
        "summary": "Export",
        "http": "GET",
        "path": "/spreadsheets/{spreadsheetId}/sheet/csv",
        "read": true,
        "binary": true
    },
    {
        "id": "spreadsheet.post.spreadsheets.sheet.rename",
        "product": "spreadsheet",
        "summary": "Rename",
        "http": "POST",
        "path": "/spreadsheets/{spreadsheetId}/sheet/rename",
        "read": false
    },
    {
        "id": "spreadsheet.post.spreadsheets.sheet.delete",
        "product": "spreadsheet",
        "summary": "Delete",
        "http": "POST",
        "path": "/spreadsheets/{spreadsheetId}/sheet/delete",
        "read": false
    },
    {
        "id": "spreadsheet.post.spreadsheets.create",
        "product": "spreadsheet",
        "summary": "Create",
        "http": "POST",
        "path": "/spreadsheets/create",
        "read": false
    },
    {
        "id": "spreadsheet.get.spreadsheets",
        "product": "spreadsheet",
        "summary": "Get",
        "http": "GET",
        "path": "/spreadsheets/{spreadsheetId}",
        "read": true
    },
    {
        "id": "spreadsheet.get.spreadsheets.xlsx",
        "product": "spreadsheet",
        "summary": "Export",
        "http": "GET",
        "path": "/spreadsheets/{spreadsheetId}/xlsx",
        "read": true,
        "binary": true
    },
    {
        "id": "spreadsheet.post.spreadsheets.batchUpdate",
        "product": "spreadsheet",
        "summary": "Batch Update",
        "http": "POST",
        "path": "/spreadsheets/{spreadsheetId}/batchUpdate",
        "read": false
    },
    {
        "id": "spreadsheet.post.spreadsheets.delete",
        "product": "spreadsheet",
        "summary": "Delete",
        "http": "POST",
        "path": "/spreadsheets/delete",
        "read": false
    },
    {
        "id": "spreadsheet.get.spreadsheets.admin.fastifyMetrics",
        "product": "spreadsheet",
        "summary": "Get metric",
        "http": "GET",
        "path": "/spreadsheets/admin/fastifyMetrics",
        "read": true,
        "metrics": true
    },
    {
        "id": "spreadsheet.get.spreadsheets.admin.metrics",
        "product": "spreadsheet",
        "summary": "Get user count",
        "http": "GET",
        "path": "/spreadsheets/admin/metrics",
        "read": true,
        "metrics": true
    }
];
export function suiteOp(id) {
    return SUITE_OPS.find((op) => op.id === id);
}
