ok - answer 转发：waiting 卡 questions 选项完整下发
ok - answer 回写：COMMAND_ANSWER ack ok
ok - answer 回写：决议 decision=answer
ok - answer 回写：CLI 收 deny-message 续跑至 DONE，终文本含「饺子」（实际: 饺子）
ok - timeout 转发：waiting 卡 questions 选项完整下发
ok - timeout 超时：timeout 决议帧在场（decision=timeout）
ok - timeout 超时：无人作答 CLI 放行续跑至 DONE（无死锁、无需 kill）
ok - timeout 迟到作答：注入送达 ack ok（）
ok - timeout 迟到作答：sendMessage 注入落帧（【AskUserQuestion 迟到作答】）

9 passed, 0 failed
