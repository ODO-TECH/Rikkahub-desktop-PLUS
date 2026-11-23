import { expect,test } from "bun:test";
import { Database } from "bun:sqlite";
import {ensureConversationTables,upsertConversationRowInto,toListDto} from "./index";
import { getConversationMeta } from "./read-queries";
import type {Conversation} from "../foundation/types";

test("execution mode defaults to agent and survives upsert, metadata reads and list DTOs",()=>{
  const db=new Database(":memory:");ensureConversationTables(db);
  const conversation:Conversation={id:"mode",assistantId:"a",title:"mixed",systemPrompt:null,messages:[],chatSuggestions:[],isPinned:false,createAt:1,updateAt:1};
  try{
    upsertConversationRowInto(db,conversation);
    expect(getConversationMeta(db,"mode")?.executionMode).toBe("agent");
    conversation.conversationKind="chat";conversation.executionMode="chat";upsertConversationRowInto(db,conversation);
    expect(getConversationMeta(db,"mode")?.conversationKind).toBe("chat");
    expect(toListDto(getConversationMeta(db,"mode")!,false).conversationKind).toBe("chat");
    conversation.executionMode="chat";upsertConversationRowInto(db,conversation);
    const restored=getConversationMeta(db,"mode")!;
    expect(restored.executionMode).toBe("chat");expect(toListDto(restored,false).executionMode).toBe("chat");
    conversation.executionMode="agent";upsertConversationRowInto(db,conversation);
    expect(getConversationMeta(db,"mode")?.executionMode).toBe("agent");
  }finally{db.close();}
});
