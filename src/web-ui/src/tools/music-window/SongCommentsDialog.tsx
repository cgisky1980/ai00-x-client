/**
 * SongCommentsDialog — 歌曲讨论弹窗（迁移 030：评论统一）
 *
 * 歌曲的讨论统一落在社区（凡歌必有帖）：本弹窗按 shareId 找到对应社区帖
 * （GET /community/posts/by-share/{shareId}），读写 community_comments。
 * 乐窗旧 share_comments 接口保留但不再使用。发歌动作产生的歌曲帖即为讨论主阵地，
 * 社区广场的同一张帖子卡与本弹窗看到同一条评论流。
 */
import React, { useEffect, useState } from 'react'
import { useI18n } from '@/infrastructure/i18n'
import { Button, Empty, Input, Modal, toastError } from '@/component-library'
import { Loader2, Send } from 'lucide-react'
import { MemberAvatar } from '@/app/member-chat/components/MemberAvatar'
import {
  communityApi,
  type CommunityComment,
} from '@/app/member-chat/community/communityApi'
import { useMemberChatStore } from '@/app/member-chat/store/memberChatStore'
import { formatRelTime } from '@/app/member-chat/community/time'

export const SongCommentsDialog: React.FC<{
  open: boolean
  shareId: string
  songTitle: string
  onClose: () => void
}> = ({ open, shareId, songTitle, onClose }) => {
  const { t } = useI18n('community')
  const [postId, setPostId] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [comments, setComments] = useState<CommunityComment[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const my = useMemberChatStore((s) => s.myProfile)

  useEffect(() => {
    if (!open || !shareId) return
    let alive = true
    setLoading(true)
    setPostId(null)
    setComments([])
    void (async () => {
      try {
        const { post_id } = await communityApi.postByShare(shareId)
        if (!alive) return
        setPostId(post_id)
        const r = await communityApi.listComments(post_id, { limit: 50 })
        if (alive) setComments(r.comments)
      } catch (_e) {
        if (alive) toastError(t('songDiscussUnavailable', { defaultValue: '这首歌还没有社区讨论帖' }))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shareId])

  const submit = async () => {
    const content = draft.trim()
    if (!content || postId == null || sending) return
    setSending(true)
    try {
      const c = await communityApi.createComment(postId, content)
      setComments((prev) => [...prev, c])
      setDraft('')
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={`${t('songDiscuss', { defaultValue: '歌曲讨论' })} · ${songTitle}`}
      size="medium"
    >
      <div className="song-comments">
        {loading ? (
          <div className="song-comments__loading">
            <Loader2 size={16} className="is-spinning" />
          </div>
        ) : postId == null ? (
          <Empty
            title={t('songDiscussUnavailable', { defaultValue: '这首歌还没有社区讨论帖' })}
            description={t('songDiscussUnavailableHint', { defaultValue: '重新发行或联系作者后可拥有讨论区' })}
          />
        ) : (
          <>
            <div className="song-comments__list">
              {comments.length === 0 && (
                <Empty
                  title={t('songDiscussEmpty', { defaultValue: '还没有评论' })}
                  description={t('songDiscussEmptyHint', { defaultValue: '说点什么，第一个发言吧' })}
                />
              )}
              {comments.map((c) => (
                <div key={c.id} className="song-comments__item">
                  <MemberAvatar
                    name={c.nickname || c.username}
                    size="sm"
                    data={c.avatar}
                  />
                  <div className="song-comments__bubble">
                    <div className="song-comments__head">
                      <span className="song-comments__name">{c.nickname || c.username}</span>
                      <span className="song-comments__time ds-data">{formatRelTime(c.created_at)}</span>
                    </div>
                    <div className="song-comments__content">{c.content}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="song-comments__composer">
              <MemberAvatar
                name={my?.nickname || my?.username || '?'}
                size="sm"
                data={my?.avatarData ?? null}
              />
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t('songDiscussPlaceholder', { defaultValue: '友善发言…' })}
                inputSize="small"
                maxLength={1000}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void submit()
                  }
                }}
              />
              <Button
                variant="primary"
                size="small"
                isLoading={sending}
                disabled={!draft.trim()}
                onClick={() => void submit()}
                aria-label={t('common:send', { defaultValue: '发送' })}
              >
                <Send size={13} />
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
