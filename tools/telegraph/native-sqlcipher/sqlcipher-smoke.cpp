#include <jni.h>
#include <sqlite3.h>
#include <fstream>
#include <string>
#include <cstdio>
// Android instrumentation-only wrapper around the SAME SQLCipher engine linked
// into op-sqlite. It is not a replacement library and never ships in the app.
extern "C" JNIEXPORT jstring JNICALL Java_com_portava_telegraph_validation_CipherEngineTest_roundTrip(JNIEnv* env, jobject, jstring location) {
 const char* raw=env->GetStringUTFChars(location,nullptr); std::string path(raw); env->ReleaseStringUTFChars(location,raw);
 std::remove(path.c_str()); sqlite3* db=nullptr;
 auto fail=[&](const char* message){ if(db)sqlite3_close(db);std::remove(path.c_str());return env->NewStringUTF(message); };
 const std::string key="synthetic-encryption-key-never-production";
 if(sqlite3_open(path.c_str(),&db)!=SQLITE_OK)return fail("open failed");
 if(sqlite3_key(db,key.data(),static_cast<int>(key.size()))!=SQLITE_OK)return fail("key failed");
 if(sqlite3_exec(db,"CREATE TABLE bodies(id TEXT PRIMARY KEY, body TEXT NOT NULL);INSERT INTO bodies VALUES('one','SYNTHETIC_PRIVATE_BODY');",nullptr,nullptr,nullptr)!=SQLITE_OK)return fail("write failed");
 sqlite3_close(db);db=nullptr;
 std::ifstream file(path,std::ios::binary);std::string bytes((std::istreambuf_iterator<char>(file)),{});file.close();
 if(bytes.rfind("SQLite format 3",0)==0||bytes.find("SYNTHETIC_PRIVATE_BODY")!=std::string::npos)return fail("plaintext present");
 if(sqlite3_open(path.c_str(),&db)!=SQLITE_OK)return fail("reopen failed");
 sqlite3_key(db,"wrong-key",9);
 if(sqlite3_exec(db,"SELECT * FROM bodies",nullptr,nullptr,nullptr)==SQLITE_OK)return fail("wrong key accepted");
 sqlite3_close(db);db=nullptr;
 if(sqlite3_open(path.c_str(),&db)!=SQLITE_OK)return fail("correct reopen failed");
 sqlite3_key(db,key.data(),static_cast<int>(key.size()));
 std::string body,version;
 auto collect=[](void* value,int count,char** cells,char**)->int { if(count>0&&cells[0])*static_cast<std::string*>(value)=cells[0];return 0; };
 if(sqlite3_exec(db,"PRAGMA cipher_version",collect,&version,nullptr)!=SQLITE_OK||version.empty())return fail("cipher version absent");
 if(sqlite3_exec(db,"SELECT body FROM bodies WHERE id='one'",collect,&body,nullptr)!=SQLITE_OK||body!="SYNTHETIC_PRIVATE_BODY")return fail("recovery failed");
 sqlite3_close(db);db=nullptr;std::remove(path.c_str());return env->NewStringUTF(("PASS SQLCipher "+version).c_str());
}
