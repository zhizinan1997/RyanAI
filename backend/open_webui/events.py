from __future__ import annotations

import asyncio
import inspect
import logging
import time
import uuid
from typing import Any

from fastapi import Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

from open_webui.env import ENABLE_FUNCTIONS, VERSION
from open_webui.models.config import Config
from open_webui.retrieval.web.utils import validate_url
from open_webui.utils.webhook import post_webhook

log = logging.getLogger(__name__)

MAX_STRING_LENGTH = 1000
EVENT_WEBHOOKS_CONFIG_KEY = 'events.webhooks'
LEGACY_WEBHOOK_CONFIG_KEY = 'webhook_url'
DEFAULT_WEBHOOK_ID = 'default'


class EventDefinition(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    description: str | None = None
    message: str | None = None

    @model_validator(mode='after')
    def defaults(self) -> 'EventDefinition':
        title = self.name.replace('.', ' ').replace('_', ' ').title()
        if self.description is None:
            object.__setattr__(self, 'description', f'{title}.')
        if self.message is None:
            object.__setattr__(self, 'message', title)
        return self


class EventDefinitions(BaseModel):
    model_config = ConfigDict(frozen=True)

    COMMENT_CREATED: EventDefinition = EventDefinition(
        name='comment.created', description='已创建一条资源评论或回复。', message='评论已创建'
    )
    COMMENT_UPDATED: EventDefinition = EventDefinition(
        name='comment.updated', description='已编辑一条资源评论。', message='评论已更新'
    )

    SYSTEM_STARTUP_STARTED: EventDefinition = EventDefinition(
        name='system.startup.started', description='应用已开始启动。', message='启动已开始'
    )
    SYSTEM_STARTUP_COMPLETED: EventDefinition = EventDefinition(
        name='system.startup.completed', description='应用启动已完成。', message='启动已完成'
    )
    SYSTEM_SHUTDOWN_STARTED: EventDefinition = EventDefinition(
        name='system.shutdown.started', description='应用已开始关闭。', message='关闭已开始'
    )
    SYSTEM_SHUTDOWN_COMPLETED: EventDefinition = EventDefinition(
        name='system.shutdown.completed', description='应用关闭已完成。', message='关闭已完成'
    )
    CONFIG_IMPORTED: EventDefinition = EventDefinition(
        name='config.imported', description='已导入配置。', message='配置已导入'
    )
    CONFIG_UPDATED: EventDefinition = EventDefinition(
        name='config.updated', description='已更新配置。', message='配置已更新'
    )
    CONFIG_WEBHOOK_UPDATED: EventDefinition = EventDefinition(
        name='config.webhook.updated',
        description='已更新事件 Webhook 配置。',
        message='Webhook 配置已更新',
    )
    CONFIG_CONNECTIONS_UPDATED: EventDefinition = EventDefinition(
        name='config.connections.updated',
        description='已更新连接配置。',
        message='连接配置已更新',
    )
    CONFIG_TOOL_SERVERS_UPDATED: EventDefinition = EventDefinition(
        name='config.tool_servers.updated',
        description='已更新工具服务器配置。',
        message='工具服务器配置已更新',
    )
    CONFIG_TERMINAL_SERVERS_UPDATED: EventDefinition = EventDefinition(
        name='config.terminal_servers.updated',
        description='已更新终端服务器配置。',
        message='终端服务器配置已更新',
    )
    CONFIG_CODE_EXECUTION_UPDATED: EventDefinition = EventDefinition(
        name='config.code_execution.updated',
        description='已更新代码执行配置。',
        message='代码执行配置已更新',
    )
    CONFIG_MODELS_UPDATED: EventDefinition = EventDefinition(
        name='config.models.updated', description='已更新模型配置。', message='模型配置已更新'
    )
    CONFIG_BANNERS_UPDATED: EventDefinition = EventDefinition(
        name='config.banners.updated', description='已更新横幅配置。', message='横幅配置已更新'
    )
    CONFIG_NOTIFICATIONS_UPDATED: EventDefinition = EventDefinition(
        name='config.notifications.updated',
        description='已更新通知配置。',
        message='通知配置已更新',
    )
    CONFIG_SUGGESTIONS_UPDATED: EventDefinition = EventDefinition(
        name='config.suggestions.updated',
        description='已更新建议配置。',
        message='建议配置已更新',
    )
    AUTH_SIGNUP: EventDefinition = EventDefinition(
        name='auth.signup', description='已通过注册创建用户账户。', message='用户已注册'
    )
    AUTH_MFA_ENROLLED: EventDefinition = EventDefinition(
        name='auth.mfa.enrolled', description='已登记 MFA。', message='MFA 已登记'
    )
    AUTH_MFA_REPLACED: EventDefinition = EventDefinition(
        name='auth.mfa.replaced', description='已更换 MFA。', message='MFA 已更换'
    )
    AUTH_MFA_FAILED: EventDefinition = EventDefinition(
        name='auth.mfa.failed', description='MFA 验证失败。', message='MFA 验证失败'
    )
    AUTH_MFA_THROTTLED: EventDefinition = EventDefinition(
        name='auth.mfa.throttled', description='MFA 请求被限流。', message='MFA 请求被限流'
    )
    AUTH_MFA_RECOVERY_USED: EventDefinition = EventDefinition(
        name='auth.mfa.recovery_used', description='已使用 MFA 恢复码。', message='已使用 MFA 恢复码'
    )
    AUTH_MFA_RECOVERY_CODES_REGENERATED: EventDefinition = EventDefinition(
        name='auth.mfa.recovery_codes_regenerated',
        description='已重新生成 MFA 恢复码。',
        message='MFA 恢复码已重新生成',
    )
    AUTH_MFA_RESET_REQUESTED: EventDefinition = EventDefinition(
        name='auth.mfa.reset_requested', description='已请求重置 MFA。', message='已请求重置 MFA'
    )
    AUTH_MFA_RESET_COMPLETED: EventDefinition = EventDefinition(
        name='auth.mfa.reset_completed', description='MFA 重置已完成。', message='MFA 重置已完成'
    )
    AUTH_MFA_POLICY_CHANGED: EventDefinition = EventDefinition(
        name='auth.mfa.policy_changed', description='MFA 策略已变更。', message='MFA 策略已变更'
    )
    AUTH_LOGIN: EventDefinition = EventDefinition(
        name='auth.login', description='用户已成功登录。', message='用户已登录'
    )
    AUTH_SESSIONS_REVOKED: EventDefinition = EventDefinition(
        name='auth.sessions_revoked', description='已撤销该用户的所有会话。', message='用户会话已撤销'
    )
    AUTH_LOGOUT: EventDefinition = EventDefinition(
        name='auth.logout', description='用户已退出登录。', message='用户已退出登录'
    )
    AUTH_PASSWORD_CHANGED: EventDefinition = EventDefinition(
        name='auth.password_changed', description='已修改用户密码。', message='密码已修改'
    )
    AUTH_API_KEY_CREATED: EventDefinition = EventDefinition(
        name='auth.api_key.created', description='已创建用户 API 密钥。', message='API 密钥已创建'
    )
    AUTH_API_KEY_DELETED: EventDefinition = EventDefinition(
        name='auth.api_key.deleted', description='已删除用户 API 密钥。', message='API 密钥已删除'
    )
    AUTH_OAUTH_SESSION_DELETED: EventDefinition = EventDefinition(
        name='auth.oauth_session.deleted', description='已删除 OAuth 会话。', message='OAuth 会话已删除'
    )
    USER_CREATED: EventDefinition = EventDefinition(
        name='user.created', description='已创建用户账户。', message='用户已创建'
    )
    USER_UPDATED: EventDefinition = EventDefinition(
        name='user.updated', description='已更新用户账户。', message='用户已更新'
    )
    USER_DELETED: EventDefinition = EventDefinition(
        name='user.deleted', description='已删除用户账户。', message='用户已删除'
    )
    USER_ROLE_UPDATED: EventDefinition = EventDefinition(
        name='user.role_updated', description='已更新用户角色。', message='用户角色已更新'
    )
    USER_STATUS_UPDATED: EventDefinition = EventDefinition(
        name='user.status_updated', description='已更新用户状态。', message='用户状态已更新'
    )
    USER_SETTINGS_UPDATED: EventDefinition = EventDefinition(
        name='user.settings_updated', description='已更新用户设置对象。', message='用户设置已更新'
    )
    USER_PROFILE_UPDATED: EventDefinition = EventDefinition(
        name='user.profile_updated', description='已更新用户资料。', message='用户资料已更新'
    )
    USER_PERMISSIONS_UPDATED: EventDefinition = EventDefinition(
        name='user.permissions_updated',
        description='已更新用户权限对象。',
        message='用户权限已更新',
    )
    GROUP_CREATED: EventDefinition = EventDefinition(
        name='group.created', description='已创建组。', message='组已创建'
    )
    GROUP_UPDATED: EventDefinition = EventDefinition(
        name='group.updated', description='已更新组。', message='组已更新'
    )
    GROUP_DELETED: EventDefinition = EventDefinition(
        name='group.deleted', description='已删除组。', message='组已删除'
    )
    GROUP_MEMBER_ADDED: EventDefinition = EventDefinition(
        name='group.member_added', description='已将用户添加到组。', message='组成员已添加'
    )
    GROUP_MEMBER_REMOVED: EventDefinition = EventDefinition(
        name='group.member_removed', description='已将用户从组中移除。', message='组成员已移除'
    )
    CHAT_CREATED: EventDefinition = EventDefinition(
        name='chat.created', description='已创建对话。', message='对话已创建'
    )
    CHAT_FINISHED: EventDefinition = EventDefinition(
        name='chat.finished', description='对话响应已完成。', message='对话已完成'
    )
    CHAT_FAILED: EventDefinition = EventDefinition(
        name='chat.failed', description='对话响应失败。', message='对话失败'
    )
    CHAT_IMPORTED: EventDefinition = EventDefinition(
        name='chat.imported', description='已导入一个对话。', message='对话已导入'
    )
    CHAT_UPDATED: EventDefinition = EventDefinition(
        name='chat.updated', description='已更新一个对话。', message='对话已更新'
    )
    CHAT_DELETED: EventDefinition = EventDefinition(
        name='chat.deleted', description='已删除一个对话。', message='对话已删除'
    )
    CHAT_DELETED_ALL: EventDefinition = EventDefinition(
        name='chat.deleted_all', description='已删除某个范围内的全部对话。', message='全部对话已删除'
    )
    CHAT_COMPACTED: EventDefinition = EventDefinition(
        name='chat.compacted', description='已压缩一个对话。', message='对话已压缩'
    )
    CHAT_PINNED: EventDefinition = EventDefinition(
        name='chat.pinned', description='已置顶一个对话。', message='对话已置顶'
    )
    CHAT_UNPINNED: EventDefinition = EventDefinition(
        name='chat.unpinned', description='已取消置顶一个对话。', message='对话已取消置顶'
    )
    CHAT_CLONED: EventDefinition = EventDefinition(
        name='chat.cloned', description='已克隆一个对话。', message='对话已克隆'
    )
    CHAT_ARCHIVED: EventDefinition = EventDefinition(
        name='chat.archived', description='已归档一个对话。', message='对话已归档'
    )
    CHAT_UNARCHIVED: EventDefinition = EventDefinition(
        name='chat.unarchived', description='已取消归档一个对话。', message='对话已取消归档'
    )
    CHAT_SHARED: EventDefinition = EventDefinition(
        name='chat.shared', description='已分享一个对话。', message='对话已分享'
    )
    CHAT_UNSHARED: EventDefinition = EventDefinition(
        name='chat.unshared', description='已取消分享一个对话。', message='对话已取消分享'
    )
    CHAT_FOLDER_UPDATED: EventDefinition = EventDefinition(
        name='chat.folder_updated', description='已更新对话的目录分配。', message='对话目录已更新'
    )
    CHAT_TAG_ADDED: EventDefinition = EventDefinition(
        name='chat.tag_added', description='已为对话添加标签。', message='对话标签已添加'
    )
    CHAT_TAG_REMOVED: EventDefinition = EventDefinition(
        name='chat.tag_removed', description='已从对话移除标签。', message='对话标签已移除'
    )
    MESSAGE_CREATED: EventDefinition = EventDefinition(
        name='message.created', description='已创建一条消息。', message='消息已创建'
    )
    MESSAGE_UPDATED: EventDefinition = EventDefinition(
        name='message.updated', description='已更新一条消息。', message='消息已更新'
    )
    MESSAGE_DELETED: EventDefinition = EventDefinition(
        name='message.deleted', description='已删除一条消息。', message='消息已删除'
    )
    MESSAGE_EVENT_RECEIVED: EventDefinition = EventDefinition(
        name='message.event_received',
        description='已接收到消息级事件。',
        message='消息事件已接收',
    )
    MESSAGE_REACTION_ADDED: EventDefinition = EventDefinition(
        name='message.reaction_added',
        description='已为一条消息添加表情回应。',
        message='消息回应已添加',
    )
    MESSAGE_REACTION_REMOVED: EventDefinition = EventDefinition(
        name='message.reaction_removed',
        description='已从一条消息移除表情回应。',
        message='消息回应已移除',
    )
    MESSAGE_PINNED: EventDefinition = EventDefinition(
        name='message.pinned', description='已置顶一条消息。', message='消息已置顶'
    )
    MESSAGE_UNPINNED: EventDefinition = EventDefinition(
        name='message.unpinned', description='已取消置顶一条消息。', message='消息已取消置顶'
    )
    CHANNEL_CREATED: EventDefinition = EventDefinition(
        name='channel.created', description='已创建一个频道。', message='频道已创建'
    )
    CHANNEL_UPDATED: EventDefinition = EventDefinition(
        name='channel.updated', description='已更新一个频道。', message='频道已更新'
    )
    CHANNEL_DELETED: EventDefinition = EventDefinition(
        name='channel.deleted', description='已删除一个频道。', message='频道已删除'
    )
    CHANNEL_MEMBER_ADDED: EventDefinition = EventDefinition(
        name='channel.member_added', description='已向频道添加成员。', message='频道成员已添加'
    )
    CHANNEL_MEMBER_REMOVED: EventDefinition = EventDefinition(
        name='channel.member_removed',
        description='已从频道移除成员。',
        message='频道成员已移除',
    )
    CHANNEL_MEMBER_ACTIVE_UPDATED: EventDefinition = EventDefinition(
        name='channel.member_active_updated',
        description='已更新频道成员的活跃状态。',
        message='频道成员活跃状态已更新',
    )
    CHANNEL_MESSAGE: EventDefinition = EventDefinition(
        name='channel.message',
        description='已发布一条频道消息。',
        message='频道消息',
    )
    CHANNEL_WEBHOOK_CREATED: EventDefinition = EventDefinition(
        name='channel.webhook.created',
        description='已创建一个频道传入 Webhook。',
        message='频道 Webhook 已创建',
    )
    CHANNEL_WEBHOOK_UPDATED: EventDefinition = EventDefinition(
        name='channel.webhook.updated',
        description='已更新一个频道传入 Webhook。',
        message='频道 Webhook 已更新',
    )
    CHANNEL_WEBHOOK_DELETED: EventDefinition = EventDefinition(
        name='channel.webhook.deleted',
        description='已删除一个频道传入 Webhook。',
        message='频道 Webhook 已删除',
    )
    FILE_UPLOADED: EventDefinition = EventDefinition(
        name='file.uploaded', description='已上传一个文件。', message='文件已上传'
    )
    FILE_CONTENT_UPDATED: EventDefinition = EventDefinition(
        name='file.content_updated', description='已更新文件内容。', message='文件内容已更新'
    )
    FILE_RENAMED: EventDefinition = EventDefinition(
        name='file.renamed', description='已重命名一个文件。', message='文件已重命名'
    )
    FILE_DELETED: EventDefinition = EventDefinition(
        name='file.deleted', description='已删除一个文件。', message='文件已删除'
    )
    FILE_DELETED_ALL: EventDefinition = EventDefinition(
        name='file.deleted_all', description='已删除某个范围内的全部文件。', message='全部文件已删除'
    )
    FOLDER_CREATED: EventDefinition = EventDefinition(
        name='folder.created', description='已创建一个目录。', message='目录已创建'
    )
    FOLDER_UPDATED: EventDefinition = EventDefinition(
        name='folder.updated', description='已更新一个目录。', message='目录已更新'
    )
    FOLDER_PARENT_UPDATED: EventDefinition = EventDefinition(
        name='folder.parent_updated', description='已更新目录的父级。', message='目录父级已更新'
    )
    FOLDER_ACCESS_UPDATED: EventDefinition = EventDefinition(
        name='folder.access_updated', description='已更新目录的访问权限。', message='目录访问权限已更新'
    )
    FOLDER_DELETED: EventDefinition = EventDefinition(
        name='folder.deleted', description='已删除一个目录。', message='目录已删除'
    )
    NOTE_CREATED: EventDefinition = EventDefinition(
        name='note.created', description='已创建一条笔记。', message='笔记已创建'
    )
    NOTE_UPDATED: EventDefinition = EventDefinition(
        name='note.updated', description='已更新一条笔记。', message='笔记已更新'
    )
    NOTE_ACCESS_UPDATED: EventDefinition = EventDefinition(
        name='note.access_updated', description='已更新笔记的访问权限。', message='笔记访问权限已更新'
    )
    NOTE_PINNED: EventDefinition = EventDefinition(
        name='note.pinned', description='已置顶一条笔记。', message='笔记已置顶'
    )
    NOTE_UNPINNED: EventDefinition = EventDefinition(
        name='note.unpinned', description='已取消置顶一条笔记。', message='笔记已取消置顶'
    )
    NOTE_DELETED: EventDefinition = EventDefinition(
        name='note.deleted', description='已删除一条笔记。', message='笔记已删除'
    )
    MEMORY_CREATED: EventDefinition = EventDefinition(
        name='memory.created', description='已创建一条记忆。', message='记忆已创建'
    )
    MEMORY_UPDATED: EventDefinition = EventDefinition(
        name='memory.updated', description='记忆已更新。', message='记忆已更新'
    )
    MEMORY_DELETED: EventDefinition = EventDefinition(
        name='memory.deleted', description='记忆已删除。', message='记忆已删除'
    )
    MEMORY_RESET: EventDefinition = EventDefinition(
        name='memory.reset', description='记忆已重置。', message='记忆已重置'
    )
    KNOWLEDGE_CREATED: EventDefinition = EventDefinition(
        name='knowledge.created', description='知识库已创建。', message='知识库已创建'
    )
    KNOWLEDGE_UPDATED: EventDefinition = EventDefinition(
        name='knowledge.updated', description='知识库已更新。', message='知识库已更新'
    )
    KNOWLEDGE_DELETED: EventDefinition = EventDefinition(
        name='knowledge.deleted', description='知识库已删除。', message='知识库已删除'
    )
    KNOWLEDGE_RESET: EventDefinition = EventDefinition(
        name='knowledge.reset', description='知识库已重置。', message='知识库已重置'
    )
    KNOWLEDGE_REINDEXED: EventDefinition = EventDefinition(
        name='knowledge.reindexed', description='知识库已重建索引。', message='知识库已重建索引'
    )
    KNOWLEDGE_ACCESS_UPDATED: EventDefinition = EventDefinition(
        name='knowledge.access_updated', description='知识库访问权限已更新。', message='知识库访问权限已更新'
    )
    KNOWLEDGE_FILE_ADDED: EventDefinition = EventDefinition(
        name='knowledge.file.added', description='文件已添加到知识库。', message='知识库文件已添加'
    )
    KNOWLEDGE_FILE_UPDATED: EventDefinition = EventDefinition(
        name='knowledge.file.updated', description='知识库文件已更新。', message='知识库文件已更新'
    )
    KNOWLEDGE_FILE_REMOVED: EventDefinition = EventDefinition(
        name='knowledge.file.removed',
        description='文件已从知识库移除。',
        message='知识库文件已移除',
    )
    KNOWLEDGE_FILE_MOVED: EventDefinition = EventDefinition(
        name='knowledge.file.moved', description='知识库文件已移动。', message='知识库文件已移动'
    )
    KNOWLEDGE_DIRECTORY_CREATED: EventDefinition = EventDefinition(
        name='knowledge.directory.created',
        description='知识库目录已创建。',
        message='知识库目录已创建',
    )
    KNOWLEDGE_DIRECTORY_UPDATED: EventDefinition = EventDefinition(
        name='knowledge.directory.updated',
        description='知识库目录已更新。',
        message='知识库目录已更新',
    )
    KNOWLEDGE_DIRECTORY_DELETED: EventDefinition = EventDefinition(
        name='knowledge.directory.deleted',
        description='知识库目录已删除。',
        message='知识库目录已删除',
    )
    KNOWLEDGE_EXTERNAL_CONNECTION_CREATED: EventDefinition = EventDefinition(
        name='knowledge.external_connection.created',
        description='知识库外部连接已创建。',
        message='知识库外部连接已创建',
    )
    KNOWLEDGE_EXTERNAL_CONNECTION_UPDATED: EventDefinition = EventDefinition(
        name='knowledge.external_connection.updated',
        description='知识库外部连接已更新。',
        message='知识库外部连接已更新',
    )
    KNOWLEDGE_EXTERNAL_CONNECTION_DELETED: EventDefinition = EventDefinition(
        name='knowledge.external_connection.deleted',
        description='知识库外部连接已删除。',
        message='知识库外部连接已删除',
    )
    RETRIEVAL_CONTENT_PROCESSED: EventDefinition = EventDefinition(
        name='retrieval.content.processed',
        description='检索内容已处理。',
        message='检索内容已处理',
    )
    RETRIEVAL_CONTENT_PROCESS_FAILED: EventDefinition = EventDefinition(
        name='retrieval.content.process_failed',
        description='检索内容处理失败。',
        message='检索内容处理失败',
    )
    RETRIEVAL_COLLECTION_DELETED: EventDefinition = EventDefinition(
        name='retrieval.collection.deleted',
        description='检索合集已删除。',
        message='检索合集已删除',
    )
    RETRIEVAL_VECTOR_DB_RESET: EventDefinition = EventDefinition(
        name='retrieval.vector_db.reset',
        description='检索向量数据库已重置。',
        message='检索向量数据库已重置',
    )
    RETRIEVAL_UPLOADS_RESET: EventDefinition = EventDefinition(
        name='retrieval.uploads.reset', description='检索上传已重置。', message='检索上传已重置'
    )
    MODEL_CREATED: EventDefinition = EventDefinition(
        name='model.created', description='模型已创建。', message='模型已创建'
    )
    MODEL_IMPORTED: EventDefinition = EventDefinition(
        name='model.imported', description='模型已导入。', message='模型已导入'
    )
    MODEL_SYNCED: EventDefinition = EventDefinition(
        name='model.synced', description='模型已同步。', message='模型已同步'
    )
    MODEL_UPDATED: EventDefinition = EventDefinition(
        name='model.updated', description='模型已更新。', message='模型已更新'
    )
    MODEL_DELETED: EventDefinition = EventDefinition(
        name='model.deleted', description='模型已删除。', message='模型已删除'
    )
    MODEL_ENABLED: EventDefinition = EventDefinition(
        name='model.enabled', description='模型已启用。', message='模型已启用'
    )
    MODEL_DISABLED: EventDefinition = EventDefinition(
        name='model.disabled', description='模型已停用。', message='模型已停用'
    )
    MODEL_AVAILABLE: EventDefinition = EventDefinition(
        name='model.available',
        description='模型出现在已获取的模型列表中。',
        message='模型可用',
    )
    MODEL_UNAVAILABLE: EventDefinition = EventDefinition(
        name='model.unavailable',
        description='模型已从已获取的模型列表中消失。',
        message='模型不可用',
    )
    MODEL_ACCESS_UPDATED: EventDefinition = EventDefinition(
        name='model.access_updated', description='模型访问权限已更新。', message='模型访问权限已更新'
    )
    MODEL_PROVIDER_CONFIG_UPDATED: EventDefinition = EventDefinition(
        name='model.provider_config.updated',
        description='模型提供商配置已更新。',
        message='模型提供商配置已更新',
    )
    MODEL_PROVIDER_REQUEST_FAILED: EventDefinition = EventDefinition(
        name='model.provider_request.failed',
        description='模型提供商请求失败。',
        message='模型提供商请求失败',
    )
    MODEL_PROVIDER_MODEL_CREATED: EventDefinition = EventDefinition(
        name='model.provider_model.created',
        description='提供商模型已创建。',
        message='提供商模型已创建',
    )
    MODEL_PROVIDER_MODEL_DELETED: EventDefinition = EventDefinition(
        name='model.provider_model.deleted',
        description='提供商模型已删除。',
        message='提供商模型已删除',
    )
    FUNCTION_CREATED: EventDefinition = EventDefinition(
        name='function.created', description='函数已创建。', message='函数已创建'
    )
    FUNCTION_UPDATED: EventDefinition = EventDefinition(
        name='function.updated', description='函数已更新。', message='函数已更新'
    )
    FUNCTION_DELETED: EventDefinition = EventDefinition(
        name='function.deleted', description='函数已删除。', message='函数已删除'
    )
    FUNCTION_ENABLED: EventDefinition = EventDefinition(
        name='function.enabled', description='函数已启用。', message='函数已启用'
    )
    FUNCTION_DISABLED: EventDefinition = EventDefinition(
        name='function.disabled', description='函数已停用。', message='函数已停用'
    )
    FUNCTION_ENABLE_STARTED: EventDefinition = EventDefinition(
        name='function.enable_started',
        description='函数即将启用。',
        message='函数开始启用',
    )
    FUNCTION_DISABLE_STARTED: EventDefinition = EventDefinition(
        name='function.disable_started',
        description='函数即将停用。',
        message='函数开始停用',
    )
    FUNCTION_VALVES_UPDATED: EventDefinition = EventDefinition(
        name='function.valves_updated', description='函数配置项已更新。', message='函数配置项已更新'
    )
    TOOL_CREATED: EventDefinition = EventDefinition(
        name='tool.created', description='工具已创建。', message='工具已创建'
    )
    TOOL_UPDATED: EventDefinition = EventDefinition(
        name='tool.updated', description='工具已更新。', message='工具已更新'
    )
    TOOL_ENABLED: EventDefinition = EventDefinition(
        name='tool.enabled', description='工具已启用。', message='工具已启用'
    )
    TOOL_DISABLED: EventDefinition = EventDefinition(
        name='tool.disabled', description='工具已停用。', message='工具已停用'
    )
    TOOL_DELETED: EventDefinition = EventDefinition(
        name='tool.deleted', description='工具已删除。', message='工具已删除'
    )
    TOOL_ACCESS_UPDATED: EventDefinition = EventDefinition(
        name='tool.access_updated', description='工具访问权限已更新。', message='工具访问权限已更新'
    )
    TOOL_VALVES_UPDATED: EventDefinition = EventDefinition(
        name='tool.valves_updated', description='工具配置项已更新。', message='工具配置项已更新'
    )
    SKILL_CREATED: EventDefinition = EventDefinition(
        name='skill.created', description='技能已创建。', message='技能已创建'
    )
    SKILL_UPDATED: EventDefinition = EventDefinition(
        name='skill.updated', description='技能已更新。', message='技能已更新'
    )
    SKILL_DELETED: EventDefinition = EventDefinition(
        name='skill.deleted', description='技能已删除。', message='技能已删除'
    )
    SKILL_ENABLED: EventDefinition = EventDefinition(
        name='skill.enabled', description='技能已启用。', message='技能已启用'
    )
    SKILL_DISABLED: EventDefinition = EventDefinition(
        name='skill.disabled', description='技能已停用。', message='技能已停用'
    )
    PROMPT_CREATED: EventDefinition = EventDefinition(
        name='prompt.created', description='提示词已创建。', message='提示词已创建'
    )
    PROMPT_UPDATED: EventDefinition = EventDefinition(
        name='prompt.updated', description='提示词已更新。', message='提示词已更新'
    )
    PROMPT_DELETED: EventDefinition = EventDefinition(
        name='prompt.deleted', description='提示词已删除。', message='提示词已删除'
    )
    PROMPT_ENABLED: EventDefinition = EventDefinition(
        name='prompt.enabled', description='提示词已启用。', message='提示词已启用'
    )
    PROMPT_DISABLED: EventDefinition = EventDefinition(
        name='prompt.disabled', description='提示词已停用。', message='提示词已停用'
    )
    PROMPT_VERSION_UPDATED: EventDefinition = EventDefinition(
        name='prompt.version_updated', description='提示词版本已更新。', message='提示词版本已更新'
    )
    PROMPT_ACCESS_UPDATED: EventDefinition = EventDefinition(
        name='prompt.access_updated', description='提示词访问权限已更新。', message='提示词访问权限已更新'
    )
    PIPELINE_UPLOADED: EventDefinition = EventDefinition(
        name='pipeline.uploaded', description='Pipeline 已上传。', message='Pipeline 已上传'
    )
    PIPELINE_ADDED: EventDefinition = EventDefinition(
        name='pipeline.added', description='Pipeline 已添加。', message='Pipeline 已添加'
    )
    PIPELINE_DELETED: EventDefinition = EventDefinition(
        name='pipeline.deleted', description='Pipeline 已删除。', message='Pipeline 已删除'
    )
    PIPELINE_VALVES_UPDATED: EventDefinition = EventDefinition(
        name='pipeline.valves_updated', description='Pipeline 配置项已更新。', message='Pipeline 配置项已更新'
    )
    CALENDAR_CREATED: EventDefinition = EventDefinition(
        name='calendar.created', description='日程已创建。', message='日程已创建'
    )
    CALENDAR_UPDATED: EventDefinition = EventDefinition(
        name='calendar.updated', description='日程已更新。', message='日程已更新'
    )
    CALENDAR_DELETED: EventDefinition = EventDefinition(
        name='calendar.deleted', description='日程已删除。', message='日程已删除'
    )
    CALENDAR_DEFAULT_UPDATED: EventDefinition = EventDefinition(
        name='calendar.default_updated',
        description='默认日程已更新。',
        message='默认日程已更新',
    )
    CALENDAR_EVENT_CREATED: EventDefinition = EventDefinition(
        name='calendar.event.created', description='日程事件已创建。', message='日程事件已创建'
    )
    CALENDAR_EVENT_UPDATED: EventDefinition = EventDefinition(
        name='calendar.event.updated', description='日程事件已更新。', message='日程事件已更新'
    )
    CALENDAR_EVENT_DELETED: EventDefinition = EventDefinition(
        name='calendar.event.deleted', description='日程事件已删除。', message='日程事件已删除'
    )
    CALENDAR_EVENT_RSVP_UPDATED: EventDefinition = EventDefinition(
        name='calendar.event.rsvp_updated',
        description='日程事件的 RSVP 已更新。',
        message='日程事件 RSVP 已更新',
    )
    CALENDAR_ALERT: EventDefinition = EventDefinition(
        name='calendar.alert',
        description='已触发日程事件提醒。',
        message='日程提醒',
    )
    AUTOMATION_CREATED: EventDefinition = EventDefinition(
        name='automation.created', description='自动化任务已创建。', message='自动化任务已创建'
    )
    AUTOMATION_UPDATED: EventDefinition = EventDefinition(
        name='automation.updated', description='自动化任务已更新。', message='自动化任务已更新'
    )
    AUTOMATION_ENABLED: EventDefinition = EventDefinition(
        name='automation.enabled', description='自动化任务已启用。', message='自动化任务已启用'
    )
    AUTOMATION_DISABLED: EventDefinition = EventDefinition(
        name='automation.disabled', description='自动化任务已停用。', message='自动化任务已停用'
    )
    AUTOMATION_DELETED: EventDefinition = EventDefinition(
        name='automation.deleted', description='自动化任务已删除。', message='自动化任务已删除'
    )
    AUTOMATION_RUN_STARTED: EventDefinition = EventDefinition(
        name='automation.run_started', description='自动化任务已开始运行。', message='自动化任务开始运行'
    )
    AUTOMATION_RUN_COMPLETED: EventDefinition = EventDefinition(
        name='automation.run_completed', description='自动化任务运行完成。', message='自动化任务运行完成'
    )
    AUTOMATION_RUN_FAILED: EventDefinition = EventDefinition(
        name='automation.run_failed', description='自动化任务运行失败。', message='自动化任务运行失败'
    )
    FEEDBACK_CREATED: EventDefinition = EventDefinition(
        name='feedback.created', description='反馈已创建。', message='反馈已创建'
    )
    FEEDBACK_UPDATED: EventDefinition = EventDefinition(
        name='feedback.updated', description='反馈已更新。', message='反馈已更新'
    )
    FEEDBACK_DELETED: EventDefinition = EventDefinition(
        name='feedback.deleted', description='反馈已删除。', message='反馈已删除'
    )
    FEEDBACK_DELETED_ALL: EventDefinition = EventDefinition(
        name='feedback.deleted_all', description='已删除指定范围内的全部反馈。', message='全部反馈已删除'
    )
    IMAGE_GENERATED: EventDefinition = EventDefinition(
        name='image.generated', description='图片已生成。', message='图片已生成'
    )
    IMAGE_EDITED: EventDefinition = EventDefinition(
        name='image.edited', description='图片已编辑。', message='图片已编辑'
    )
    AUDIO_SPEECH_REQUESTED: EventDefinition = EventDefinition(
        name='audio.speech_requested', description='已请求语音生成。', message='语音生成请求'
    )
    AUDIO_TRANSCRIPTION_REQUESTED: EventDefinition = EventDefinition(
        name='audio.transcription_requested',
        description='已请求音频转写。',
        message='音频转写请求',
    )
    TERMINAL_SESSION_OPENED: EventDefinition = EventDefinition(
        name='terminal.session.opened', description='终端会话已打开。', message='终端会话已打开'
    )
    TERMINAL_SESSION_CLOSED: EventDefinition = EventDefinition(
        name='terminal.session.closed', description='终端会话已关闭。', message='终端会话已关闭'
    )
    NOTIFICATION_TEST: EventDefinition = EventDefinition(
        name='notification.test', description='已向通知目标发送测试通知。', message='通知测试'
    )
    NOTIFICATION_MANUAL: EventDefinition = EventDefinition(
        name='notification.manual', description='已发送手动通知。', message='通知已发送'
    )


EVENTS = EventDefinitions()
EVENT_DEFINITIONS = tuple(getattr(EVENTS, field_name) for field_name in EventDefinitions.model_fields)
EVENT_DEFINITIONS_BY_NAME = {definition.name: definition for definition in EVENT_DEFINITIONS}
EVENT_CATALOG = tuple(definition.name for definition in EVENT_DEFINITIONS)
EVENT_CATALOG_SET = set(EVENT_CATALOG)
NOTIFICATION_EVENTS = (
    EVENTS.CHAT_FINISHED.name,
    EVENTS.CHAT_FAILED.name,
    EVENTS.CHANNEL_MESSAGE.name,
    EVENTS.CALENDAR_ALERT.name,
    EVENTS.AUTOMATION_RUN_FAILED.name,
)


def get_event_catalog() -> list[dict[str, str]]:
    return [
        {
            'event': definition.name,
            'description': definition.description,
            'message': definition.message,
        }
        for definition in EVENT_DEFINITIONS
    ]


SENSITIVE_KEYS = {
    'password',
    'hashed_password',
    'token',
    'access_token',
    'refresh_token',
    'id_token',
    'api_key',
    'secret',
    'key',
    'authorization',
    'cookie',
    'webhook_token',
}

SAFE_ACTOR_FIELDS = ('id', 'name', 'email', 'role', 'created_at', 'updated_at')


def normalize_event_webhook(webhook: dict[str, Any], *, create: bool = False) -> dict[str, Any]:
    now = int(time.time())
    webhook_id = str(webhook.get('id') or uuid.uuid4())
    url = str(webhook.get('url') or '').strip()

    events = [str(event).strip() for event in (webhook.get('events') or ['*']) if str(event).strip()]
    events = events or ['*']
    for event_filter in events:
        if event_filter == '*':
            continue
        if event_filter.endswith('.*'):
            prefix = event_filter[:-2]
            if prefix and any(event.startswith(f'{prefix}.') for event in EVENT_CATALOG):
                continue
            raise ValueError(f'Invalid event pattern: {event_filter}')
        if event_filter not in EVENT_CATALOG_SET:
            raise ValueError(f'Invalid event: {event_filter}')

    targets = normalize_event_targets(webhook.get('targets'))

    return {
        'id': webhook_id,
        'name': str(webhook.get('name') or ('Default webhook' if webhook_id == DEFAULT_WEBHOOK_ID else 'Webhook')),
        'url': url,
        'enabled': bool(webhook.get('enabled', True)),
        'events': events,
        'targets': targets,
        'created_at': int(webhook.get('created_at') or now),
        'updated_at': now if create or webhook.get('updated_at') is None else int(webhook.get('updated_at') or now),
    }


def normalize_event_targets(targets: Any) -> list[dict[str, str]] | None:
    if targets is None:
        return None
    if not isinstance(targets, list):
        raise ValueError('Invalid targets')

    normalized = []
    seen = set()
    for target in targets:
        if not isinstance(target, dict):
            raise ValueError('Invalid target')

        target_type = str(target.get('type') or '').strip()
        target_id = str(target.get('id') or '').strip()
        if target_type not in {'user', 'group'} or not target_id:
            raise ValueError('Invalid target')

        key = (target_type, target_id)
        if key in seen:
            continue

        normalized.append({'type': target_type, 'id': target_id})
        seen.add(key)

    return normalized


def event_filter_matches(webhook: dict[str, Any], event_name: str) -> bool:
    if not webhook.get('enabled', True):
        return False

    for event_filter in webhook.get('events') or ['*']:
        if event_filter == '*':
            return True
        if event_filter.endswith('.*') and event_name.startswith(f'{event_filter[:-2]}.'):
            return True
        if event_name == event_filter:
            return True
    return False


def event_user_ids(event: 'Event') -> set[str]:
    user_ids = set()
    actor = event.actor or {}
    subject = event.subject or {}
    data = event.data or {}

    if actor.get('id'):
        user_ids.add(str(actor['id']))

    if subject.get('type') == 'user' and subject.get('id'):
        user_ids.add(str(subject['id']))

    if data.get('user_id'):
        user_ids.add(str(data['user_id']))

    for user_id in data.get('user_ids') or []:
        if user_id:
            user_ids.add(str(user_id))

    return user_ids


async def event_target_matches(
    targets: list[dict[str, str]] | None,
    user_ids: set[str],
    user_group_ids: dict[str, set[str]] | None = None,
) -> bool:
    if targets is None:
        return True
    if not targets:
        return not user_ids
    if not user_ids:
        return False

    target_user_ids = {target['id'] for target in targets if target.get('type') == 'user'}
    if target_user_ids.intersection(user_ids):
        return True

    target_group_ids = {target['id'] for target in targets if target.get('type') == 'group'}
    if not target_group_ids:
        return False

    if user_group_ids is None:
        from open_webui.models.groups import Groups

        groups_by_user = await Groups.get_groups_by_member_ids(list(user_ids), include_inherited=True)
        user_group_ids = {user_id: {group.id for group in groups} for user_id, groups in groups_by_user.items()}

    return any(group_ids.intersection(target_group_ids) for group_ids in user_group_ids.values())


async def event_webhook_matches(webhook: dict[str, Any], event: 'Event') -> bool:
    if not event_filter_matches(webhook, event.event):
        return False

    return await event_target_matches(webhook.get('targets'), event_user_ids(event))


async def get_event_webhooks() -> list[dict[str, Any]]:
    webhooks = await Config.get(EVENT_WEBHOOKS_CONFIG_KEY, []) or []
    if not isinstance(webhooks, list):
        return []

    normalized = []
    for webhook in webhooks:
        if not isinstance(webhook, dict):
            continue
        try:
            normalized.append(normalize_event_webhook(webhook))
        except ValueError:
            log.exception('Invalid event webhook config skipped')
    return normalized


async def migrate_legacy_webhook_config() -> list[dict[str, Any]]:
    webhooks = await get_event_webhooks()
    if any(webhook.get('id') == DEFAULT_WEBHOOK_ID for webhook in webhooks):
        return webhooks

    now = int(time.time())
    legacy_url = await Config.get(LEGACY_WEBHOOK_CONFIG_KEY) or ''
    if not legacy_url:
        return webhooks

    webhooks = [
        {
            'id': DEFAULT_WEBHOOK_ID,
            'name': 'Default webhook',
            'url': legacy_url,
            'enabled': True,
            'events': ['*'],
            'targets': None,
            'created_at': now,
            'updated_at': now,
        },
        *webhooks,
    ]
    await Config.upsert({EVENT_WEBHOOKS_CONFIG_KEY: webhooks})
    return webhooks


async def upsert_event_webhook(webhook: dict[str, Any]) -> dict[str, Any]:
    webhooks = await get_event_webhooks()
    url = str(webhook.get('url') or '').strip()
    if url:
        validate_url(url)

    normalized = normalize_event_webhook(webhook, create=True)
    replaced = False
    next_webhooks = []

    for existing in webhooks:
        if existing.get('id') == normalized['id']:
            next_webhooks.append(
                {
                    **existing,
                    **normalized,
                    'created_at': existing.get('created_at') or normalized['created_at'],
                }
            )
            replaced = True
        else:
            next_webhooks.append(existing)

    if not replaced:
        next_webhooks.append(normalized)

    await Config.upsert({EVENT_WEBHOOKS_CONFIG_KEY: next_webhooks})
    return next(webhook for webhook in next_webhooks if webhook.get('id') == normalized['id'])


async def delete_event_webhook(webhook_id: str) -> bool:
    webhooks = await get_event_webhooks()
    next_webhooks = [webhook for webhook in webhooks if webhook.get('id') != webhook_id]
    if len(next_webhooks) == len(webhooks):
        return False

    values = {EVENT_WEBHOOKS_CONFIG_KEY: next_webhooks}
    if webhook_id == DEFAULT_WEBHOOK_ID:
        values[LEGACY_WEBHOOK_CONFIG_KEY] = ''

    await Config.upsert(values)
    return True


class Event(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    schema_: str = Field(alias='schema')
    id: str
    event: str
    resource: str
    operation: str
    created_at: int
    instance_id: str | None
    version: str
    source: str
    actor: dict[str, Any] | None = None
    subject: dict[str, Any] | None = None
    data: dict[str, Any] = Field(default_factory=dict)
    message: str | None = None

    def model_dump(self, *args, **kwargs) -> dict[str, Any]:
        kwargs.setdefault('by_alias', True)
        return super().model_dump(*args, **kwargs)


def _sensitive(key: Any) -> bool:
    normalized = str(key).lower().replace('-', '_')
    return (
        normalized in SENSITIVE_KEYS
        or normalized.endswith('_token')
        or normalized.endswith('_secret')
        or normalized.endswith('_api_key')
        or normalized.endswith('_key')
    )


def _sanitize(value: Any) -> Any:
    if hasattr(value, 'model_dump'):
        value = value.model_dump()

    if isinstance(value, dict):
        return {key: _sanitize(item) for key, item in value.items() if not _sensitive(key)}

    if isinstance(value, (list, tuple, set)):
        return [_sanitize(item) for item in value]

    if isinstance(value, str) and len(value) > MAX_STRING_LENGTH:
        return f'{value[:MAX_STRING_LENGTH]}...'

    return value


def _actor(actor: Any | None) -> dict[str, Any] | None:
    actor = _sanitize(actor)
    if not actor:
        return None

    get = actor.get if isinstance(actor, dict) else lambda key: getattr(actor, key, None)
    data = {field: get(field) for field in SAFE_ACTOR_FIELDS if get(field) is not None}
    if not data:
        return None

    data['type'] = get('type') or 'user'
    return data


def event_name(event: EventDefinition | str) -> str:
    name = event.name if isinstance(event, EventDefinition) else str(event)
    if name not in EVENT_CATALOG_SET:
        raise ValueError(f'Unknown event: {name}')
    return name


def build_event(
    request: Request | None,
    event: EventDefinition | str,
    *,
    actor: Any | None = None,
    subject_id: Any | None = None,
    subject_type: str | None = None,
    source: str = 'api',
    data: dict | None = None,
    message: str | None = None,
    event_id: str | None = None,
) -> Event:
    event_name_value = event_name(event)
    app = request.app if request is not None else None
    parts = event_name_value.split('.')
    resource = '.'.join(parts[:-1])
    instance_id = getattr(getattr(app, 'state', None), 'instance_id', None)
    subject = (
        {'type': subject_type or resource, 'id': subject_id}
        if subject_id is not None or subject_type is not None
        else None
    )

    return Event(
        schema=VERSION,
        id=event_id or str(uuid.uuid4()),
        event=event_name_value,
        resource=resource,
        operation=parts[-1],
        created_at=int(time.time()),
        instance_id=instance_id,
        version=VERSION,
        source=source,
        actor=_actor(actor),
        subject=_sanitize(subject) if subject else None,
        data=_sanitize(data or {}),
        message=message,
    )


async def dispatch_webhook_event(app: Any, event: Event) -> None:
    # LICENSE covers this Open WebUI webhook identifier.
    # Do not alter, remove, obscure, or replace it except as LICENSE permits:
    # https://docs.openwebui.com/license.
    name = getattr(getattr(app, 'state', None), 'WEBUI_NAME', 'Open WebUI')
    subject = event.subject or {}
    subject_id = subject.get('id')
    definition = EVENT_DEFINITIONS_BY_NAME.get(event.event)
    message = event.message or (definition.message if definition else event.event)
    if subject_id:
        message = f'{message} ({subject_id})'

    for webhook in await get_event_webhooks():
        if not webhook.get('url') or not await event_webhook_matches(webhook, event):
            continue

        try:
            await post_webhook(
                name,
                webhook['url'],
                message,
                event.model_dump(),
                description=definition.description if definition else None,
            )
        except Exception:
            log.exception('Event webhook failed for %s', webhook.get('id'))


def schedule_webhook_dispatch(app: Any, event: Event) -> None:
    try:
        asyncio.create_task(dispatch_webhook_event(app, event))
    except RuntimeError:
        log.exception('Event webhook delivery could not be scheduled for %s', event.event)


class WebhookEventSink:
    async def handle_event(self, request: Request, event: Event) -> None:
        schedule_webhook_dispatch(request.app, event)


def schedule_notification_dispatch(app: Any, event: Event) -> None:
    try:
        from open_webui.utils.notifications import dispatch_notification_event

        asyncio.create_task(dispatch_notification_event(app, event))
    except RuntimeError:
        log.exception('Notification delivery could not be scheduled for %s', event.event)


class NotificationEventSink:
    async def handle_event(self, request: Request, event: Event) -> None:
        if event.event in NOTIFICATION_EVENTS:
            schedule_notification_dispatch(request.app, event)


class SocketSessionEventSink:
    async def handle_event(self, request: Request, event: Event) -> None:
        from open_webui.socket.main import refresh_chat_access

        if event.event in {
            EVENTS.FOLDER_ACCESS_UPDATED.name,
            EVENTS.FOLDER_UPDATED.name,
            EVENTS.FOLDER_PARENT_UPDATED.name,
            EVENTS.FOLDER_DELETED.name,
            EVENTS.CHAT_DELETED_ALL.name,
        }:
            await refresh_chat_access()
        elif event.event in {
            EVENTS.CHAT_SHARED.name,
            EVENTS.CHAT_UNSHARED.name,
            EVENTS.CHAT_FOLDER_UPDATED.name,
            EVENTS.CHAT_DELETED.name,
            EVENTS.CHAT_ARCHIVED.name,
        }:
            subject = event.subject or {}
            # User-scoped events (archive all, unshare all) recheck every chat.
            await refresh_chat_access(subject.get('id') if subject.get('type') == 'chat' else None)

        if event.event not in {EVENTS.USER_DELETED.name, EVENTS.USER_ROLE_UPDATED.name}:
            return

        subject = event.subject or {}
        if subject.get('type') != 'user' or not subject.get('id'):
            return

        from open_webui.socket.main import disconnect_user_sessions

        await disconnect_user_sessions(str(subject['id']))


async def dispatch_event_functions(request: Request, event: Event, extra_function_ids: list[str] | None = None) -> None:
    if not ENABLE_FUNCTIONS:
        return

    from open_webui.models.functions import Functions
    from open_webui.utils.plugin import get_function_module_from_cache

    event_payload = event.model_dump()

    try:
        event_functions = await Functions.get_functions_by_type('event', active_only=True)
        if extra_function_ids:
            extra_functions = await Functions.get_functions_by_ids(extra_function_ids)
            existing_ids = {function.id for function in event_functions}
            event_functions.extend(
                function for function in extra_functions if function.type == 'event' and function.id not in existing_ids
            )
    except Exception:
        log.exception('Event functions could not be loaded for %s', event.event)
        return

    for function in event_functions:
        try:
            function_module, _, _ = await get_function_module_from_cache(request, function.id, function=function)
            handler = getattr(function_module, 'event', None)
            if not handler:
                continue

            if hasattr(function_module, 'valves') and hasattr(function_module, 'Valves'):
                valves = await Functions.get_function_valves_by_id(function.id)
                function_module.valves = function_module.Valves(**(valves if valves else {}))

            sig = inspect.signature(handler)
            accepts_kwargs = any(param.kind == inspect.Parameter.VAR_KEYWORD for param in sig.parameters.values())
            extra_params = {
                'event': event_payload,
                '__id__': function.id,
                '__event__': event,
                '__event_id__': event.id,
                '__event_name__': event.event,
                '__app__': request.app,
                '__request__': request,
            }
            params = {key: value for key, value in extra_params.items() if accepts_kwargs or key in sig.parameters}

            if inspect.iscoroutinefunction(handler):
                await handler(**params)
            else:
                handler(**params)
        except Exception:
            log.exception('Event function failed for %s', function.id)


def schedule_event_function_dispatch(request: Request, event: Event) -> None:
    try:
        asyncio.create_task(dispatch_event_functions(request, event))
    except RuntimeError:
        log.exception('Event functions could not be scheduled for %s', event.event)


class EventFunctionSink:
    async def handle_event(self, request: Request, event: Event) -> None:
        schedule_event_function_dispatch(request, event)


EVENT_SINKS = [SocketSessionEventSink(), EventFunctionSink(), WebhookEventSink(), NotificationEventSink()]


async def _dispatch_event(request, event_payload):
    for sink in EVENT_SINKS:
        try:
            await sink.handle_event(request, event_payload)
        except Exception:
            log.exception('Event sink failed for %s', event_payload.event)


async def publish_event(
    request: Request,
    event: EventDefinition | str | Event,
    *,
    actor: Any | None = None,
    subject_id: Any | None = None,
    subject_type: str | None = None,
    source: str = 'api',
    data: dict | None = None,
    message: str | None = None,
) -> None:
    """Deliver an event through the existing sinks. Call after committing source changes."""
    event_payload = (
        event
        if isinstance(event, Event)
        else build_event(
            request,
            event,
            actor=actor,
            subject_id=subject_id,
            subject_type=subject_type,
            source=source,
            data=data,
            message=message,
        )
    )
    await _dispatch_event(request, event_payload)


async def publish_model_provider_request_failed(
    request: Request,
    *,
    actor: Any | None,
    provider: str,
    base_url: str,
    status: int,
    requested_model: str | None = None,
    api_key: str | None = None,
    upstream_error: Any = None,
) -> None:
    error = upstream_error.get('error') if isinstance(upstream_error, dict) else upstream_error
    error_code = None
    if isinstance(error, dict):
        error_code = error.get('code') or error.get('type') or error.get('error_code')
        error = error.get('message') or error.get('detail') or error

    error_text = str(error or '')
    marker = f'{error_code or ""} {error_text}'.lower()
    error_type = (
        'model_not_found'
        if status == 404
        and any(value in marker for value in ('model_not_found', 'model not found', 'does not exist', 'no such model'))
        else 'authentication_failed'
        if status in (401, 403)
        else 'rate_limited'
        if status == 429
        else 'server_failed'
        if status >= 500
        else 'upstream_error'
    )

    # Server-log only; the upstream error body is otherwise invisible to admins
    # (event sinks require an event function or webhook to be configured).
    log.log(
        logging.ERROR if status >= 500 else logging.WARNING,
        'Upstream %s request failed: HTTP %d (%s) url=%s model=%s code=%s message=%s',
        provider,
        status,
        error_type,
        base_url,
        requested_model or '-',
        error_code or '-',
        error_text[:MAX_STRING_LENGTH] or '-',
    )

    data = {
        'error_type': error_type,
        'status': status,
        'provider': provider,
        'base_url': base_url,
    }
    if requested_model:
        data['requested_model'] = requested_model
    if api_key:
        data['api_key_suffix'] = f'...{api_key[-4:]}'
    if error_code:
        data['upstream_error_code'] = error_code
    if error:
        data['upstream_message'] = error

    if hasattr(request, 'state') and requested_model:
        failures = getattr(request.state, 'model_provider_failures', {})
        failures[str(requested_model)] = data
        request.state.model_provider_failures = failures

    await publish_event(
        request,
        EVENTS.MODEL_PROVIDER_REQUEST_FAILED,
        actor=actor,
        subject_id=requested_model,
        subject_type='model',
        data=data,
    )
