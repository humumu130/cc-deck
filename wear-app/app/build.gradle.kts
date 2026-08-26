plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.humumu.ccwatch"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.humumu.ccwatch"
        minSdk = 26
        targetSdk = 36
        versionCode = 5
        versionName = "0.2.3"
        buildConfigField("boolean", "DEMO_DEFAULT", "true")
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // 不升级：compose 1.7.3+ 与 wear-compose 1.4.0 组合会令 ScalingLazyColumn 的
    // 缩放/透明变换完全失效（真机像素测量证实），1.7.0 为验证过的配对版本
    implementation(platform("androidx.compose:compose-bom:2024.09.00"))
    implementation("androidx.compose.material:material")
    implementation("androidx.wear.compose:compose-material:1.4.0")
    implementation("androidx.wear.compose:compose-foundation:1.4.0")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("com.google.android.gms:play-services-wearable:19.0.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
